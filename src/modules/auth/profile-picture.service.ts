import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from "@nestjs/common";
import { UploadApiOptions, v2 as cloudinary } from "cloudinary";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { FirebaseAdminService } from "../firebase-admin/firebase-admin.service";
import { AuthenticatedUser } from "./authenticated-user";
import { hashForAudit } from "../../common/security-audit";
import { assertCloudinaryConfigured } from "../../common/env";

export interface UploadProfilePictureInput {
  imageBase64: string;
  contentType?: string;
}

export interface ProfilePictureResponse {
  url: string;
  path: string;
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
]);

@Injectable()
export class ProfilePictureService {
  private readonly logger = new Logger(ProfilePictureService.name);

  constructor(
    @Inject(FirebaseAdminService)
    private readonly firebaseAdmin: FirebaseAdminService,
  ) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });
  }

  /**
   * Uploads a profile picture to Cloudinary and stores the URL in Firestore and Firebase Auth
   */
  async uploadProfilePicture(
    user: AuthenticatedUser,
    input: UploadProfilePictureInput,
  ): Promise<ProfilePictureResponse> {
    assertCloudinaryConfigured();

    if (!input || !input.imageBase64) {
      throw new BadRequestException("Image data (imageBase64) is required.");
    }

    const parsed = this.parseImageBody(input.imageBase64, input.contentType);
    const buffer = Buffer.from(parsed.base64, "base64");

    if (!buffer.length) {
      throw new BadRequestException("Uploaded image is empty.");
    }

    if (buffer.length > MAX_IMAGE_BYTES) {
      throw new BadRequestException(
        "Image exceeds the maximum allowed size of 5 MB.",
      );
    }

    const userEmail = user.email?.trim().toLowerCase();
    if (!userEmail) {
      throw new BadRequestException("User email is required.");
    }

    let existingUrl: string | null = null;
    const existingDoc = await this.firebaseAdmin
      .db()
      .collection("users")
      .doc(userEmail)
      .get();

    if (existingDoc.exists) {
      const userData = existingDoc.data();
      const storedUrl =
        userData?.profilePictureUrl || userData?.profilePicture || userData?.avatarUrl;
      if (storedUrl && typeof storedUrl === "string" && storedUrl.includes("cloudinary.com")) {
        existingUrl = storedUrl;
      }
    }

    const publicId = `profile-pictures/${user.uid}/${Date.now()}_${randomUUID()}`;

    const result = await this.uploadBufferToCloudinary(buffer, {
      public_id: publicId,
      resource_type: "image",
      folder: undefined, // already encoded in publicId
      overwrite: false,
      tags: ["profile-picture", userEmail],
    });

    const now = FieldValue.serverTimestamp();

    // Update user document in Firestore
    await this.firebaseAdmin
      .db()
      .collection("users")
      .doc(userEmail)
      .set(
        {
          profilePicture: result.secure_url,
          avatarUrl: result.secure_url,
          profilePictureUrl: result.secure_url,
          profilePictureCloudinaryPath: result.public_id,
          profilePictureSource: "profile_api",
          profilePictureUpdatedAt: now,
          updatedAt: now,
        },
        { merge: true },
      );

    // Also update Firebase Auth photoURL
    if (user.uid) {
      await this.firebaseAdmin
        .auth()
        .updateUser(user.uid, { photoURL: result.secure_url })
        .catch((err) => {
          this.logger.warn(`Failed to update photoURL in Firebase Auth: ${err}`);
        });
    }

    if (existingUrl) {
      await this.deleteCloudinaryImage(existingUrl).catch((err) => {
        this.logger.warn(`Failed to delete old profile picture: ${err}`);
      });
    }

    this.logger.log(
      JSON.stringify({
        event: "profile_picture_uploaded",
        uidHash: hashForAudit(user.uid),
        emailHash: hashForAudit(userEmail),
        publicId: result.public_id,
      }),
    );

    return {
      url: result.secure_url,
      path: result.public_id,
    };
  }

  /**
   * Gets the user's current profile picture URL
   */
  async getProfilePicture(
    userOrId: AuthenticatedUser | string,
  ): Promise<ProfilePictureResponse | null> {
    const email =
      typeof userOrId === "object"
        ? userOrId.email?.trim().toLowerCase()
        : userOrId.includes("@")
          ? userOrId.trim().toLowerCase()
          : null;

    const uid = typeof userOrId === "object" ? userOrId.uid : userOrId;

    if (email) {
      const userDoc = await this.firebaseAdmin
        .db()
        .collection("users")
        .doc(email)
        .get();

      if (userDoc.exists) {
        const userData = userDoc.data();
        const url =
          userData?.profilePicture ||
          userData?.avatarUrl ||
          userData?.profilePictureUrl;
        if (url) {
          return {
            url,
            path: userData?.profilePictureCloudinaryPath || "",
          };
        }
      }
    }

    if (uid) {
      const snapshot = await this.firebaseAdmin
        .db()
        .collection("users")
        .where("uid", "==", uid)
        .limit(1)
        .get();

      if (!snapshot.empty) {
        const userData = snapshot.docs[0].data();
        const url =
          userData?.profilePicture ||
          userData?.avatarUrl ||
          userData?.profilePictureUrl;
        if (url) {
          return {
            url,
            path: userData?.profilePictureCloudinaryPath || "",
          };
        }
      }
    }

    return null;
  }

  /**
   * Deletes the user's profile picture
   */
  async deleteProfilePicture(user: AuthenticatedUser): Promise<void> {
    const userEmail = user.email?.trim().toLowerCase();
    if (!userEmail) return;

    const userDoc = await this.firebaseAdmin
      .db()
      .collection("users")
      .doc(userEmail)
      .get();

    if (userDoc.exists) {
      const userData = userDoc.data();
      const existingUrl =
        userData?.profilePictureUrl || userData?.profilePicture || userData?.avatarUrl;
      if (existingUrl && typeof existingUrl === "string" && existingUrl.includes("cloudinary.com")) {
        await this.deleteCloudinaryImage(existingUrl).catch((err) => {
          this.logger.warn(`Failed to delete Cloudinary image: ${err}`);
        });
      }
    }

    const now = FieldValue.serverTimestamp();

    // Clear from Firestore
    await this.firebaseAdmin
      .db()
      .collection("users")
      .doc(userEmail)
      .set(
        {
          profilePicture: "",
          avatarUrl: "",
          profilePictureUrl: null,
          profilePictureCloudinaryPath: null,
          profilePictureUpdatedAt: now,
          updatedAt: now,
        },
        { merge: true },
      );

    // Clear from Firebase Auth
    if (user.uid) {
      await this.firebaseAdmin
        .auth()
        .updateUser(user.uid, { photoURL: null })
        .catch((err) => {
          this.logger.warn(`Failed to clear photoURL in Firebase Auth: ${err}`);
        });
    }

    this.logger.log(
      JSON.stringify({
        event: "profile_picture_deleted",
        uidHash: hashForAudit(user.uid),
        emailHash: hashForAudit(userEmail),
      }),
    );
  }

  /**
   * Parses a base64 image and extracts the base64 content and content type
   */
  private parseImageBody(rawInput: string, explicitContentType?: string) {
    const dataUriMatch = rawInput.match(
      /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i,
    );
    const contentType = String(
      dataUriMatch?.[1] || explicitContentType || "image/jpeg",
    ).toLowerCase();

    if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
      throw new BadRequestException(
        `Unsupported image type: ${contentType}. Allowed types: ${Array.from(ALLOWED_IMAGE_TYPES).join(", ")}`,
      );
    }

    const base64 = dataUriMatch?.[2] || rawInput;
    return { base64, contentType };
  }

  /**
   * Uploads a buffer to Cloudinary using a stream
   */
  private uploadBufferToCloudinary(
    buffer: Buffer,
    options: UploadApiOptions,
  ): Promise<{ secure_url: string; public_id: string }> {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        options,
        (error, result) => {
          if (error) return reject(new Error(error.message));
          if (!result)
            return reject(new Error("Cloudinary returned no result."));
          resolve({
            secure_url: result.secure_url,
            public_id: result.public_id,
          });
        },
      );
      Readable.from(buffer).pipe(stream);
    });
  }

  /**
   * Deletes a Cloudinary asset given its public URL
   */
  private async deleteCloudinaryImage(url: string): Promise<void> {
    try {
      const match = url.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.[a-z]+)?$/);
      const publicId = match?.[1] ?? null;

      if (!publicId) {
        this.logger.warn(`Could not extract publicId from URL: ${url}`);
        return;
      }

      await cloudinary.uploader.destroy(publicId, { resource_type: "image" });

      this.logger.log(
        JSON.stringify({
          event: "profile_picture_deleted_from_cloudinary",
          publicId,
        }),
      );
    } catch (error) {
      this.logger.error(
        `Failed to delete Cloudinary image: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}
