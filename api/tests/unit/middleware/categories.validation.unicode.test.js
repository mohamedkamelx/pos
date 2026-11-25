'use strict';

const { validationResult } = require('express-validator');

const { validateCreateCategory } = require('../../../src/middleware/categories.validation');

async function runCreate(body) {
  const req = { body, params: {}, query: {} };
  for (const chain of validateCreateCategory) {
    await chain.run(req);
  }
  return validationResult(req);
}

describe('category name validation with Arabic and other Unicode letters', () => {
  test.each(['احذية', 'الأحذية', 'أَحْذِيَة', 'أحذية الأطفال', 'Café', 'Pantalón niño'])(
    'accepts %s',
    async (name) => {
      const result = await runCreate({ name });

      expect(result.isEmpty()).toBe(true);
    }
  );

  test('still rejects markup and other punctuation', async () => {
    const result = await runCreate({ name: 'shoes<script>' });

    expect(result.isEmpty()).toBe(false);
    expect(result.array().map((error) => error.msg)).toContain(
      'Category name contains invalid characters'
    );
  });
});
