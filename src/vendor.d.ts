declare module "bsdiff-wasm" {
  interface Module {
    FS: { writeFile(path: string, data: Uint8Array): void; readFile(path: string): Uint8Array<ArrayBuffer> };
    callMain(args: string[]): number;
  }
  export function loadBsdiff(): Promise<Module>;
  export function loadBspatch(): Promise<Module>;
}
interface ResponseInit { encodeBody?: "automatic" | "manual" }
