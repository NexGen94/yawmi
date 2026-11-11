// fake-indexeddb/auto is imported for its side effect only. Its typings do not resolve under
// "moduleResolution": "bundler" (package "exports"), which a dynamic import trips over.
declare module 'fake-indexeddb/auto';
