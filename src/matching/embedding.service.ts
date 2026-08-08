import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { createHash } from 'crypto';

@Injectable()
export class EmbeddingService {
  readonly model = 'text-embedding-3-small';
  readonly pipelineVersion = 2;
  private openai?: OpenAI;
  private readonly queryCache = new Map<string, { embedding: number[]; expiresAt: number }>();

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
      model: this.model,
      input: text,
    });

    return response.data[0].embedding;
  }

  async generateQueryEmbedding(text: string): Promise<number[]> {
    const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
    const key = this.hashText(`${this.model}:${this.pipelineVersion}:${normalized}`);
    const cached = this.queryCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.embedding;

    const embedding = await this.generateEmbedding(normalized);
    if (this.queryCache.size >= 500) {
      const oldest = this.queryCache.keys().next().value as string | undefined;
      if (oldest) this.queryCache.delete(oldest);
    }
    this.queryCache.set(key, { embedding, expiresAt: Date.now() + 6 * 60 * 60 * 1000 });
    return embedding;
  }

  contentHash(text: string) {
    return this.hashText(`${this.model}:${this.pipelineVersion}:${text}`);
  }

  private getClient() {
    this.openai = this.openai ?? new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return this.openai;
  }
}
