var path = require('path')
var fs = require('fs');
const dir = process.cwd();
/*
 * Language files live at the REPOSITORY ROOT, not under frontend/.
 *
 * They are a contribution surface before they are a build input: somebody who
 * speaks Kannada and has never opened this project should find them by looking
 * at the repository, not by knowing that the web build reads them. gulp runs
 * with frontend/ as its working directory, hence the step up.
 */
const langDir = path.resolve(dir, '..', 'languages');
const publicDir = `public`;
const s = path.sep; // Separator short form to reduce line
/*
 * The translation catalogue.
 *
 * This remains the source list for translation tooling, but it is not the
 * shipping list. The desktop build carries Arabic first and English second
 * only; the other packs stay in the repository for contributors and are not
 * emitted into the installer.
 *
 * `name` is written in the language itself - an Arabic speaker looking for
 * their language is looking for "العربية", not for "Arabic". `flag` is the
 * icon suffix the header already uses. `dir: 'rtl'` marks a right-to-left
 * script; the runtime also derives direction from the code.
 *
 * `reviewed` says whether somebody who speaks the language has read the pack
 * on a real screen. It remains metadata for the catalogue; it does not decide
 * what ships.
 */
const LANGUAGES = [
    { code: 'en', englishName: 'English', name: 'English', flag: 'us', reviewed: true },
    { code: 'ta', englishName: 'Tamil', name: 'தமிழ்', flag: 'in', reviewed: true },

    /* Complete packs, drafted from the glossary and finished by machine
       translation on 2026-09-02. Speakers wanted - see docs/TRANSLATING.md. */
    { code: 'hi', englishName: 'Hindi', name: 'हिन्दी', flag: 'in', reviewed: false },
    { code: 'ml', englishName: 'Malayalam', name: 'മലയാളം', flag: 'in', reviewed: false },
    { code: 'kn', englishName: 'Kannada', name: 'ಕನ್ನಡ', flag: 'in', reviewed: false },
    { code: 'te', englishName: 'Telugu', name: 'తెలుగు', flag: 'in', reviewed: false },
    { code: 'si', englishName: 'Sinhala', name: 'සිංහල', flag: 'lk', reviewed: false },
    { code: 'ne', englishName: 'Nepali', name: 'नेपाली', flag: 'np', reviewed: false },
    { code: 'ar', englishName: 'Arabic', name: 'العربية', flag: 'sa', dir: 'rtl', reviewed: false },
    { code: 'fr', englishName: 'French', name: 'Français', flag: 'fr', reviewed: false },
    { code: 'es', englishName: 'Spanish', name: 'Español', flag: 'es', reviewed: false },
    { code: 'pt', englishName: 'Portuguese', name: 'Português', flag: 'pt', reviewed: false },
    { code: 'id', englishName: 'Indonesian', name: 'Bahasa Indonesia', flag: 'id', reviewed: false },
    { code: 'th', englishName: 'Thai', name: 'ไทย', flag: 'th', reviewed: false },

    /* Existing European and East African packs. */
    { code: 'de', englishName: 'German', name: 'Deutsch', flag: 'de', reviewed: false },
    { code: 'sw', englishName: 'Swahili', name: 'Kiswahili', flag: 'tz', reviewed: false },
    { code: 'nl', englishName: 'Dutch Netherlands Nederlands', name: 'Nederlands', flag: 'nl', reviewed: false },
    { code: 'it', englishName: 'Italian', name: 'Italiano', flag: 'it', reviewed: false },
    // Expanded with AWS Translate; native-speaker review is still pending.
    { code: 'bg', name: 'Български', englishName: 'Bulgarian', flag: 'bg', reviewed: false },
    { code: 'cs', name: 'Čeština', englishName: 'Czech', flag: 'cz', reviewed: false },
    { code: 'da', name: 'Dansk', englishName: 'Danish', flag: 'dk', reviewed: false },
    { code: 'et', name: 'Eesti', englishName: 'Estonian', flag: 'ee', reviewed: false },
    { code: 'el', name: 'Ελληνικά', englishName: 'Greek', flag: 'gr', reviewed: false },
    { code: 'ga', name: 'Gaeilge', englishName: 'Irish', flag: 'ie', reviewed: false },
    { code: 'hr', name: 'Hrvatski', englishName: 'Croatian', flag: 'hr', reviewed: false },
    { code: 'lv', name: 'Latviešu', englishName: 'Latvian', flag: 'lv', reviewed: false },
    { code: 'lt', name: 'Lietuvių', englishName: 'Lithuanian', flag: 'lt', reviewed: false },
    { code: 'hu', name: 'Magyar', englishName: 'Hungarian', flag: 'hu', reviewed: false },
    { code: 'mt', name: 'Malti', englishName: 'Maltese', flag: 'mt', reviewed: false },
    { code: 'pl', name: 'Polski', englishName: 'Polish', flag: 'pl', reviewed: false },
    { code: 'ro', name: 'Română', englishName: 'Romanian', flag: 'ro', reviewed: false },
    { code: 'sk', name: 'Slovenčina', englishName: 'Slovak', flag: 'sk', reviewed: false },
    { code: 'sl', name: 'Slovenščina', englishName: 'Slovenian', flag: 'si', reviewed: false },
    { code: 'fi', name: 'Suomi', englishName: 'Finnish', flag: 'fi', reviewed: false },
    { code: 'sv', name: 'Svenska', englishName: 'Swedish', flag: 'se', reviewed: false },
    { code: 'nb', name: 'Norsk bokmål', englishName: 'Norwegian Bokmål', flag: 'no', reviewed: false },
    { code: 'is', name: 'Íslenska', englishName: 'Icelandic', flag: 'is', reviewed: false },
    { code: 'sq', name: 'Shqip', englishName: 'Albanian', flag: 'al', reviewed: false },
    { code: 'bs', name: 'Bosanski', englishName: 'Bosnian', flag: 'ba', reviewed: false },
    { code: 'mk', name: 'Македонски', englishName: 'Macedonian', flag: 'mk', reviewed: false },
    { code: 'sr', name: 'Српски', englishName: 'Serbian', flag: 'rs', reviewed: false },
    { code: 'uk', name: 'Українська', englishName: 'Ukrainian', flag: 'ua', reviewed: false },
    { code: 'ru', name: 'Русский', englishName: 'Russian', flag: 'ru', reviewed: false },
    { code: 'tr', name: 'Türkçe', englishName: 'Turkish', flag: 'tr', reviewed: false },
    { code: 'zh-CN', name: '简体中文', englishName: 'Chinese Simplified', flag: 'cn', reviewed: false },
    { code: 'zh-TW', name: '繁體中文', englishName: 'Chinese Traditional', flag: 'tw', reviewed: false },
    { code: 'ja', name: '日本語', englishName: 'Japanese', flag: 'jp', reviewed: false },
    { code: 'ko', name: '한국어', englishName: 'Korean', flag: 'kr', reviewed: false },
    { code: 'vi', name: 'Tiếng Việt', englishName: 'Vietnamese', flag: 'vn', reviewed: false },
    { code: 'bn', name: 'বাংলা', englishName: 'Bengali', flag: 'bd', reviewed: false },
    { code: 'ur', name: 'اردو', englishName: 'Urdu', flag: 'pk', reviewed: false, dir: 'rtl' },
    { code: 'fa', name: 'فارسی', englishName: 'Persian', flag: 'ir', reviewed: false, dir: 'rtl' },
    { code: 'he', name: 'עברית', englishName: 'Hebrew', flag: 'il', reviewed: false, dir: 'rtl' },
    { code: 'mr', name: 'मराठी', englishName: 'Marathi', flag: 'in', reviewed: false },
    { code: 'gu', name: 'ગુજરાતી', englishName: 'Gujarati', flag: 'in', reviewed: false },
    { code: 'pa', name: 'ਪੰਜਾਬੀ', englishName: 'Punjabi Gurmukhi', flag: 'in', reviewed: false },
    { code: 'ms', name: 'Bahasa Melayu', englishName: 'Malay', flag: 'my', reviewed: false },
    { code: 'tl', name: 'Filipino', englishName: 'Filipino Tagalog', flag: 'ph', reviewed: false },

];

/* Arabic is the primary language; English is the fallback. */
const SHIPPED_CODES = ['ar', 'en'];

/* What this build actually offers, in menu order. */
const shippedLanguages = SHIPPED_CODES.map((code) => {
    const language = LANGUAGES.find((entry) => entry.code === code);
    if (!language) throw new Error(`Missing language catalogue entry for ${code}`);
    return language;
});

/* Just the codes this build ships, for everything that only needs the list. */
const languages = shippedLanguages.map((l) => l.code);

const env = process.env.NODE_ENV ? process.env.NODE_ENV : 'prod';

function isDir(url) {
    return fs.lstatSync(url).isDirectory();
}

module.exports = {
    languages,
    LANGUAGES,
    shippedLanguages,
    langDir,
    publicDir,
    s,
    isDir,
    env,
};
