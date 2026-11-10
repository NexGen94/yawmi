// Run openapi-typescript against the TypeScript 5 compiler API.
//
// openapi-typescript 7 prints its output with `import ts from 'typescript'` (the JS compiler API,
// `ts.factory`, `ts.createPrinter`). This project compiles with TypeScript 7, whose npm package no
// longer exposes that API, so the generator would crash on it. The lockfile therefore carries
// TypeScript 5.9.3 under the alias `typescript-5`, and this hook sends only the imports made from
// inside openapi-typescript to it. Everything else (tsc, the app, the tests) keeps TypeScript 7.
//
// Used as: node --import ./scripts/ts5-for-openapi.mjs node_modules/openapi-typescript/bin/cli.js ...
// Remove it, the alias and the `overrides` entry once openapi-typescript supports TypeScript 7.

import { register } from 'node:module';

const hook = `
export async function resolve(specifier, context, next) {
  if (specifier === 'typescript' && context.parentURL?.includes('/node_modules/openapi-typescript/')) {
    return next('typescript-5', context);
  }
  return next(specifier, context);
}
`;

register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);
