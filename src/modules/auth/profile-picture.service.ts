import {
  BadRequestException,
  Injectable,
  Logger,
} from "@nestjs/common";
import { UploadApiOptions, v2 as cloudinary } from "cloudinary";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { FirebaseAdminService } from "../firebase-admin/firebase-admin.service";
import { AuthenticatedUser } from "./authenticated-user";

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
  private logger = new Logger(ProfilePictureService.name);

  constructor(private firebaseAdmin: FirebaseAdminService) {}

  /**
   * Uploads a profile picture to Cloudinary and stores the URL in Firestore
   */
  async uploadProfilePicture(
    user: AuthenticatedUser,
    input: UploadProfilePictureInput,
  ): Promise<ProfilePictureResponse> {
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

    // Delete old profile picture if it exists
    const userDoc = await this.firebaseAdmin.firestore
      .collection("users")
      .doc(user.uid)
      .get();

    if (userDoc.exists) {
      const userData = userDoc.data();
      if (userData?.profilePictureUrl) {
        await this.deleteCloudinaryImage(userData.profilePictureUrl).catch(
          (err) => {
            this.logger.warn(`Failed to delete old profile picture: ${err}`);
          },
        );
      }
    }

    const publicId = `profile-pictures/${user.uid}/${Date.now()}_${randomUUID()}`;

    const result = await this.uploadBufferToCloudinary(buffer, {
      public_id: publicId,
      resource_type: "image",
      folder: undefined, // already encoded in publicId
      overwrite: false,
      tags: ["profile-picture", user.email],
    });

    // Store the profile picture URL in Firestore user document
    await this.firebaseAdmin.firestore
      .collection("users")
      .doc(user.uid)
      .update({
        profilePictureUrl: result.secure_url,
        profilePictureCloudinaryPath: result.public_id,
        profilePictureUpdatedAt: new Date(),
      });

    this.logger.log(
      JSON.stringify({
        event: "profile_picture_uploaded",
        uid: user.uid,
        email: user.email,
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
  async getProfilePicture(uid: string): Promise<ProfilePictureResponse | null> {
    const userDoc = await this.firebaseAdmin.firestore
      .collection("users")
      .doc(uid)
      .get();

    if (!userDoc.exists) {
      return null;
    }

    const userData = userDoc.data();
    if (!userData?.profilePictureUrl) {
      return null;
    }

    return {
      url: userData.profilePictureUrl,
      path: userData.profilePictureCloudinaryPath || "",
    };
  }

  /**
   * Deletes the user's profile picture
   */
  async deleteProfilePicture(user: AuthenticatedUser): Promise<void> {
    const userDoc = await this.firebaseAdmin.firestore
      .collection("users")
      .doc(user.uid)
      .get();

    if (userDoc.exists) {
      const userData = userDoc.data();
      if (userData?.profilePictureUrl) {
        await this.deleteCloudinaryImage(userData.profilePictureUrl);
      }
    }

    // Clear the profile picture from Firestore
    await this.firebaseAdmin.firestore
      .collection("users")
      .doc(user.uid)
      .update({
        profilePictureUrl: null,
        profilePictureCloudinaryPath: null,
      });

    this.logger.log(
      JSON.stringify({
        event: "profile_picture_deleted",
        uid: user.uid,
        email: user.email,
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

      await new Promise<void>((resolve, reject) => {
        cloudinary.uploader.destroy(publicId, (error, result) => {
          if (error) return reject(new Error(error.message));
          resolve();
        });
      });

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
      throw error;
    }
  }
}
