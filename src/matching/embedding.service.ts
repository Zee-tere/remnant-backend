import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { createHash } from 'crypto';

@Injectable()
export class EmbeddingService {
  private openai?: OpenAI;

  isConfigured() {
    return Boolean(process.env.OPENAI_API_KEY);
  }

  buildListingText(listing: {
    intentionTag?: unknown;
    category?: unknown;
    title?: unknown;
    description?: unknown;
    pairingKeyword?: unknown;
    compatibilityAttributes?: unknown;
    city?: unknown;
    condition?: unknown;
  }): string {
    const attrs =
      listing.compatibilityAttributes &&
      typeof listing.compatibilityAttributes === 'object' &&
      !Array.isArray(listing.compatibilityAttributes)
        ? Object.entries(listing.compatibilityAttributes)
            .map(([key, value]) => `${key}:${String(value)}`)
            .join(' ')
        : '';

    return [
      listing.intentionTag,
      listing.category,
      listing.title,
      listing.description,
      listing.pairingKeyword,
      attrs,
      listing.city,
      listing.condition,
    ]
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  hashText(text: string) {
    return createHash('sha256').update(text).digest('hex');
  }

  async generateEmbedding(text: string): Promise<number[]> {
    if (!this.isConfigured()) {
      throw new Error('OPENAI_API_KEY is not configured');
    }

    const response = await this.getClient().embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
    });

    return response.data[0].embedding;
  }

  private getClient() {
    this.openai = this.openai ?? new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return this.openai;
  }
}
