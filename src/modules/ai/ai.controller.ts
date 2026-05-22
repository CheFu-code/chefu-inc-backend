import {
  BadGatewayException,
  BadRequestException,
  Controller,
  InternalServerErrorException,
  Post,
  Body,
  UseGuards,
} from '@nestjs/common';
import { Content, GoogleGenAI } from '@google/genai';
import { AuthGuard } from '../auth/auth.guard';

type AIContent = {
  role: string;
  parts: unknown[];
};

const model = 'gemini-2.5-flash';
const config = {
  responseMimeType: 'application/json',
};

@Controller('ai')
export class AiController {
  @Post('generate')
  @UseGuards(AuthGuard)
  async generate(@Body() body: { contents?: unknown }) {
    if (!this.isValidContent(body.contents)) {
      throw new BadRequestException('Invalid AI request payload.');
    }

    try {
      const ai = this.getAIClient();
      const response = await ai.models.generateContent({
        model,
        config,
        contents: body.contents,
      });
      const text = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const result = this.extractJsonFromText(text);

      if (!result) {
        throw new BadGatewayException('No content returned from AI model.');
      }

      return { result };
    } catch (error) {
      if (error instanceof BadGatewayException) throw error;
      console.error('[AI Generate API] Failed:', error);
      throw new InternalServerErrorException('Failed to generate AI content.');
    }
  }

  private getAIClient() {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      throw new InternalServerErrorException('GEMINI_API_KEY is not configured.');
    }

    return new GoogleGenAI({ apiKey });
  }

  private extractJsonFromText(text: string) {
    if (!text) return '';
    return text.replace(/^```json[\r\n]+|```$/gi, '').trim();
  }

  private isValidContent(contents: unknown): contents is Content[] {
    return (
      Array.isArray(contents) &&
      contents.every(
        item =>
          item &&
          typeof item === 'object' &&
          'role' in item &&
          'parts' in item &&
          Array.isArray((item as AIContent).parts),
      )
    );
  }
}
