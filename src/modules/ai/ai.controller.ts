import {
  BadGatewayException,
  BadRequestException,
  Controller,
  InternalServerErrorException,
  Logger,
  Post,
  Body,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';

type AIContent = {
  role: string;
  parts: unknown[];
};

const DEFAULT_MODEL = 'gemini-2.5-flash';
const MAX_CONTENTS = 12;
const MAX_PARTS_PER_CONTENT = 8;
const MAX_SERIALIZED_CONTENT_BYTES = 80_000;
const config = {
  responseMimeType: 'application/json',
};

@Controller('ai')
export class AiController {
  private readonly logger = new Logger(AiController.name);

  @Post('generate')
  @UseGuards(AuthGuard)
  async generate(@Body() body: { contents?: unknown }) {
    if (!this.isValidContent(body.contents)) {
      throw new BadRequestException('Invalid AI request payload.');
    }

    try {
      this.logger.log(
        JSON.stringify({
          event: 'ai_generate_started',
          contentCount: body.contents.length,
          model: this.model(),
        }),
      );
      const ai = await this.getAIClient();
      const response = await ai.models.generateContent({
        model: this.model(),
        config,
        contents: body.contents as never,
      });
      const text = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const result = this.extractJsonFromText(text);

      if (!result) {
        this.logger.error(JSON.stringify({ event: 'ai_generate_empty_result' }));
        throw new BadGatewayException('No content returned from AI model.');
      }

      this.logger.log(
        JSON.stringify({
          event: 'ai_generate_succeeded',
          resultLength: result.length,
        }),
      );

      return { result };
    } catch (error) {
      if (error instanceof BadGatewayException) throw error;
      console.error('[AI Generate API] Failed:', error);
      throw new InternalServerErrorException('Failed to generate AI content.');
    }
  }

  private async getAIClient() {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      throw new InternalServerErrorException('GEMINI_API_KEY is not configured.');
    }

    const { GoogleGenAI } = await import('@google/genai');
    return new GoogleGenAI({ apiKey });
  }

  private model() {
    return process.env.GEMINI_GENERATE_MODEL || process.env.GEMINI_MODEL || DEFAULT_MODEL;
  }

  private extractJsonFromText(text: string) {
    if (!text) return '';
    return text.replace(/^```json[\r\n]+|```$/gi, '').trim();
  }

  private isValidContent(contents: unknown): contents is AIContent[] {
    const serializedSize = Buffer.byteLength(JSON.stringify(contents || []));

    return (
      Array.isArray(contents) &&
      contents.length > 0 &&
      contents.length <= this.maxContents() &&
      serializedSize <= this.maxSerializedContentBytes() &&
      contents.every(
        item =>
          item &&
          typeof item === 'object' &&
          'role' in item &&
          typeof (item as AIContent).role === 'string' &&
          ['user', 'model'].includes((item as AIContent).role) &&
          'parts' in item &&
          Array.isArray((item as AIContent).parts) &&
          (item as AIContent).parts.length <= this.maxPartsPerContent(),
      )
    );
  }

  private maxContents() {
    return this.safeNumber(process.env.AI_MAX_CONTENTS, MAX_CONTENTS, 1, 50);
  }

  private maxPartsPerContent() {
    return this.safeNumber(
      process.env.AI_MAX_PARTS_PER_CONTENT,
      MAX_PARTS_PER_CONTENT,
      1,
      50,
    );
  }

  private maxSerializedContentBytes() {
    return this.safeNumber(
      process.env.AI_MAX_SERIALIZED_CONTENT_BYTES,
      MAX_SERIALIZED_CONTENT_BYTES,
      1_000,
      1_000_000,
    );
  }

  private safeNumber(
    value: string | undefined,
    fallback: number,
    minimum: number,
    maximum: number,
  ) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;

    return Math.min(Math.max(Math.floor(parsed), minimum), maximum);
  }
}
