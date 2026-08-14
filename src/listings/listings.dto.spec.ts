import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateListingDto, UpdateListingDto } from './listings.dto';

const validCreateListing = {
  clientRequestId: '3b893184-4ed1-45b8-8358-32f14245b60a',
  title: 'Cup handle',
  description: 'Fits',
  category: 'Kitchen & Home Essentials',
  condition: 'GOOD',
  intentionTag: 'SELL',
  price: '1500',
  city: 'Lagos',
  images: ['https://example.com/cup-handle.webp'],
  uploadIds: ['83ee7c1e-94b1-410d-a689-d6f5eadf65ac'],
};

function descriptionErrors(value: object) {
  return validateSync(value).filter((error) => error.property === 'description');
}

describe('listing description validation', () => {
  it('accepts a three-character description when creating a listing', () => {
    const dto = plainToInstance(CreateListingDto, { ...validCreateListing, description: 'New' });

    expect(descriptionErrors(dto)).toHaveLength(0);
  });

  it('rejects descriptions shorter than three characters when creating a listing', () => {
    const dto = plainToInstance(CreateListingDto, { ...validCreateListing, description: 'No' });

    expect(descriptionErrors(dto)[0]?.constraints?.minLength).toBe('Description must be at least 3 characters');
  });

  it('uses the same minimum when editing a listing', () => {
    const invalid = plainToInstance(UpdateListingDto, { version: 1, description: 'No' });
    const valid = plainToInstance(UpdateListingDto, { version: 1, description: 'New' });

    expect(descriptionErrors(invalid)[0]?.constraints?.minLength).toBe('Description must be at least 3 characters');
    expect(descriptionErrors(valid)).toHaveLength(0);
  });
});
