import { BadRequestException } from "@nestjs/common";
import * as validate from "./liftwise.validation";

export function encodeCursor(completedAt: string, id: string) {
  return Buffer.from(JSON.stringify([completedAt, id])).toString("base64url");
}
export function decodeCursor(value?: string): [string, string] | undefined {
  if (value === undefined) return;
  try {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) throw new Error();
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString());
    if (!Array.isArray(decoded) || decoded.length !== 2) throw new Error();
    return [validate.date(decoded[0]), validate.id(decoded[1])];
  } catch {
    throw new BadRequestException("Invalid history cursor.");
  }
}
