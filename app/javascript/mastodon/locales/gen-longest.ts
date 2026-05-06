import { writeFile, glob } from 'node:fs/promises';
import { resolve } from 'node:path';

async function main() {
  const locales: Record<string, Record<string, string>> = {};
  const localeLoader = glob('*.json', { cwd: __dirname });
  for await (const path of localeLoader) {
    const locale = path.replace('.json', '');
    // @ts-expect-error -- with: { type: 'json' } is not by the tsconfig but we use TSX.
    const { default: content } = (await import(`./${path}`, {
      with: { type: 'json' },
    })) as { default: Record<string, string> };
    locales[locale] = content;
  }

  const mainLocale = locales.en;
  if (!mainLocale) {
    throw new Error('en.json not found');
  }

  const longest: Record<string, string> = {};
  for (const [key, enString] of Object.entries(mainLocale)) {
    let longestString = enString;

    for (const localeStrings of Object.values(locales)) {
      const localeString = localeStrings[key];
      if (localeString && localeString.length > longestString.length) {
        longestString = localeString;
      }
    }

    longest[key] = longestString;
  }

  await writeFile(
    resolve(__dirname, 'xx.json'),
    JSON.stringify(longest, null, 2),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
