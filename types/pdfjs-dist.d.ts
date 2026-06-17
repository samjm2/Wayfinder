// pdfjs-dist 6 ships types for the package root but not for the ESM build
// subpath we import in the browser. Re-export the package's real types so the
// `pdfjs-dist/build/pdf.mjs` import is fully typed (GlobalWorkerOptions,
// getDocument, etc.) instead of falling back to `any`.
declare module "pdfjs-dist/build/pdf.mjs" {
  export * from "pdfjs-dist";
}
