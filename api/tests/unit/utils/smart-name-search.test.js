'use strict';

const {
  editDistance,
  expandQuery,
  nameSimilarity,
  phoneticKey,
  rankNameMatches,
  scoreNameMatch,
  smartRegexPattern,
} = require('../../../src/utils/smart-name-search');

describe('smart name search', () => {
  describe('edit distance', () => {
    test('counts a single substitution', () => {
      expect(editDistance('pepse', 'pepsi')).toBe(1);
    });

    test('is zero for identical names', () => {
      expect(editDistance('احذية', 'احذية')).toBe(0);
    });
  });

  describe('name similarity', () => {
    test('keeps a close Arabic product spelling above the strict target gate', () => {
      expect(nameSimilarity('جزمة حمرى', 'جزمة حمراء')).toBeGreaterThanOrEqual(0.72);
    });

    test('treats the definite article as the same name', () => {
      expect(nameSimilarity('الاحذية', 'احذية')).toBe(0.98);
    });
  });

  describe('scoreNameMatch', () => {
    test('ranks a broad spelling slip above unrelated categories', () => {
      expect(scoreNameMatch('الاحزايا', 'احذية')).toBeGreaterThanOrEqual(0.45);
      expect(scoreNameMatch('الاحزايا', 'احذية')).toBeGreaterThan(
        scoreNameMatch('الاحزايا', 'ملابس')
      );
    });

    test('gives an exact name the top score', () => {
      expect(scoreNameMatch('احذية', 'احذية')).toBe(1);
      expect(scoreNameMatch('احذية', 'احذية اطفال')).toBeLessThan(1);
    });
  });

  describe('rankNameMatches', () => {
    const categories = [
      { id: 'cat-1', name: 'ملابس' },
      { id: 'cat-2', name: 'احذية اطفال' },
      { id: 'cat-3', name: 'احذية' },
    ];

    test('finds the intended Arabic category from a spelling slip', () => {
      const ranked = rankNameMatches('الاحزايا', categories, (row) => row.name);
      expect(ranked[0].item.name).toBe('احذية');
    });

    test('prefers the exact category over a child category', () => {
      const ranked = rankNameMatches('احذية', categories, (row) => row.name);
      expect(ranked[0].item.name).toBe('احذية');
      expect(ranked[0].score).toBe(1);
    });

    test('leaves unrelated names out', () => {
      const ranked = rankNameMatches('الاحزايا', categories, (row) => row.name);
      expect(ranked.map((entry) => entry.item.name)).not.toContain('ملابس');
    });

    test('matches a plural category to its singular product family', () => {
      const products = [
        { name: 'غسالة سامسونج 8 كيلو' },
        { name: 'ثلاجة LG' },
      ];
      const ranked = rankNameMatches('غسالات', products, (row) => row.name);
      expect(ranked[0].item.name).toContain('غسالة');
      expect(ranked.map((entry) => entry.item.name)).not.toContain('ثلاجة LG');
    });
  });

  describe('query expansion', () => {
    test('reaches Arabic synonyms from an English shop word', () => {
      const expansion = expandQuery('washing machine');
      expect(expansion.normalized).toBe('washing machine');
      expect(expansion.forms).toEqual(expect.arrayContaining(['غساله', 'غسالات', 'غسلات']));
      expect(expansion.phrases).toEqual(expect.arrayContaining(['washing machines']));
    });

    test('turns Egyptian number words into digits without losing the word', () => {
      const expansion = expandQuery('اتنين');
      expect(expansion.tokens).toContain('اتنين');
      expect(expansion.forms).toContain('2');
    });

    test('maps an Egyptian sound-alike to the English brand', () => {
      expect(phoneticKey('شرب')).toBe(phoneticKey('sharp'));
      expect(phoneticKey('شرب')).toHaveLength(4);
      expect(phoneticKey('صابون')).not.toBe(phoneticKey('soup'));
    });
  });

  describe('safe pattern', () => {
    test('matches Arabic letter variants and keeps regex characters literal', () => {
      const pattern = new RegExp(`^${smartRegexPattern('غسالة 8')}$`, 'i');
      expect(pattern.test('غسالات 8')).toBe(false);
      expect(pattern.test('غساله 8')).toBe(true);
      expect(smartRegexPattern('.*')).toBe('(?!)');
    });
  });
});
