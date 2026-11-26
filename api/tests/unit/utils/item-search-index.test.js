'use strict';

/*
 * The item search index is what lets a cashier find a product without typing
 * its name exactly. These tests pin the two halves that have to agree:
 * normalisation (which decides what a word looks like) and ranking (which
 * decides what the cashier sees first).
 */

const {
  SEARCH_INDEX_VERSION,
  buildSearchIndex,
  compareSearchCandidates,
  ngramsForToken,
  normalizeSearchText,
  scoreSearchCandidate,
  stripSearchIndex,
  tokenizeSearchText,
  withSearchIndex,
} = require('../../../src/utils/item-search-index');

describe('item search index', () => {
  describe('normalisation', () => {
    test('folds Arabic letter variants and removes diacritics', () => {
      expect(normalizeSearchText('أَحْمَد')).toBe('احمد');
      expect(normalizeSearchText('مَدْرَسَة')).toBe('مدرسه');
      expect(normalizeSearchText('على')).toBe('علي');
      expect(normalizeSearchText('بَيْبْسِي')).toBe('بيبسي');
    });

    test('keeps Latin and Arabic words and turns punctuation into spaces', () => {
      expect(normalizeSearchText('  Pepsi-1L, Cold/Drink! ')).toBe('pepsi 1l cold drink');
      expect(normalizeSearchText('بيبسي ١ لتر')).toBe('بيبسي ١ لتر');
    });

    test('tokenises the normalised text', () => {
      expect(tokenizeSearchText('Pepsi 1L')).toEqual(['pepsi', '1l']);
      expect(tokenizeSearchText('   ')).toEqual([]);
    });
  });

  describe('n-grams', () => {
    test('includes bigrams and trigrams for typo tolerance', () => {
      const grams = ngramsForToken('pepsi');
      expect(grams).toEqual(expect.arrayContaining(['pe', 'ep', 'ps', 'si', 'pep', 'eps', 'psi']));
      expect(grams).toHaveLength(7);
    });

    test('keeps a two-letter token whole and ignores one-letter tokens', () => {
      expect(ngramsForToken('1l')).toEqual(['1l']);
      expect(ngramsForToken('a')).toEqual([]);
    });
  });

  describe('buildSearchIndex', () => {
    const item = {
      name: 'Pepsi 1L',
      category_name: 'Cold Drinks',
      description: 'A fizzy drink',
      brand: 'PepsiCo',
      tags: ['cola'],
      stock_locations: ['Aisle 4'],
      translations: [{ name: 'بيبسي', description: 'مشروب غازي' }],
      barcode_id: '6221001',
      sku: 'PEP-1L',
      barcodes: ['6221002'],
    };

    test('indexes the fields a cashier can search', () => {
      const index = buildSearchIndex(item);
      expect(index.search_index_version).toBe(SEARCH_INDEX_VERSION);
      expect(index.search_text).toContain('pepsi');
      expect(index.search_text).toContain('cold drinks');
      expect(index.search_text).toContain('fizzy');
      expect(index.search_text).toContain('بيبسي');
      expect(index.search_text).toContain('6221001');
      expect(index.search_tokens).toEqual(
        expect.arrayContaining(['pepsi', '1l', 'cold', 'drinks', 'بيبسي', '6221001', '6221002'])
      );
      expect(index.search_ngrams).toEqual(expect.arrayContaining(['pep', 'eps', 'psi']));
      expect(Array.isArray(index.search_phonetics)).toBe(true);
    });

    test('stores a phonetic key for sound-alike names and leaves short keys out', () => {
      expect(buildSearchIndex({ name: 'Sharp' }).search_phonetics).toContain('shrb');
      expect(buildSearchIndex({ name: 'شرب' }).search_phonetics).toContain('shrb');
      expect(buildSearchIndex({ name: 'Soup' }).search_phonetics).not.toContain('sb');
    });

    test('is derived data that can be removed at the read boundary', () => {
      const indexed = withSearchIndex(item);
      expect(indexed).not.toBe(item);
      expect(indexed.search_tokens.length).toBeGreaterThan(0);
      stripSearchIndex(indexed);
      expect(indexed).not.toHaveProperty('search_text');
      expect(indexed).not.toHaveProperty('search_tokens');
      expect(indexed).not.toHaveProperty('search_ngrams');
      expect(indexed).not.toHaveProperty('search_phonetics');
      expect(indexed).not.toHaveProperty('search_index_version');
      expect(indexed.name).toBe('Pepsi 1L');
    });
  });

  describe('ranking', () => {
    const pepsi = withSearchIndex({
      name: 'Pepsi 1L',
      category_name: 'Cold Drinks',
      description: 'A fizzy drink',
    });
    const soup = withSearchIndex({
      name: 'Soup',
      category_name: 'Canned food',
      description: 'Tomato soup',
    });

    test('an exact name beats a description hit', () => {
      const query = 'pepsi';
      const exact = scoreSearchCandidate(pepsi, query, ['pepsi'], ngramsForToken('pepsi'));
      const descriptionOnly = scoreSearchCandidate(
        withSearchIndex({ name: 'Cola', description: 'Pepsi-style cola' }),
        query,
        ['pepsi'],
        ngramsForToken('pepsi')
      );
      expect(exact).toBeGreaterThan(descriptionOnly);
      expect(descriptionOnly).toBeGreaterThan(0);
    });

    test('an exact barcode is the strongest match', () => {
      const byCode = withSearchIndex({ name: 'Some product', barcode_id: '6221001' });
      const score = scoreSearchCandidate(byCode, '6221001', ['6221001'], ngramsForToken('6221001'));
      expect(score).toBeGreaterThanOrEqual(120);
    });

    test('a one-letter typo still finds the product', () => {
      const score = scoreSearchCandidate(pepsi, 'pepse', ['pepse'], ngramsForToken('pepse'));
      expect(score).toBeGreaterThan(0);
    });

    test('an Arabic spelling slip still finds the product', () => {
      const shoe = withSearchIndex({ name: 'جزمة حمراء', category_name: 'احذية' });
      const score = scoreSearchCandidate(
        shoe,
        'جزمة حمرى',
        ['جزمة', 'حمرى'],
        ['جزمة', 'حمرى'].flatMap((token) => ngramsForToken(token))
      );
      expect(score).toBeGreaterThan(0);
    });

    test('a shared generic bigram alone is not a match', () => {
      const score = scoreSearchCandidate(soup, 'soap', ['soap'], ngramsForToken('soap'));
      expect(score).toBe(0);
    });

    test('category and token hits keep a product visible', () => {
      const score = scoreSearchCandidate(pepsi, 'drinks', ['drinks'], ngramsForToken('drinks'));
      expect(score).toBeGreaterThan(0);
    });

    test('sorts by score, then name', () => {
      const rows = [
        { score: 10, doc: { name: 'Beta' } },
        { score: 10, doc: { name: 'Alpha' } },
        { score: 20, doc: { name: 'Charlie' } },
      ];
      expect(rows.sort(compareSearchCandidates).map((row) => row.doc.name)).toEqual([
        'Charlie',
        'Alpha',
        'Beta',
      ]);
    });
  });
});
