// A file's text, imported with Vite's `?raw` suffix. Only the settings spec
// uses it (Vitest runs on Vite): it reads the section templates to check that
// every option the search box can jump to is really on its page. The spec
// typecheck has no Node types, so reading the files with `node:fs` is out.
declare module '*?raw' {
  const text: string;
  export default text;
}
