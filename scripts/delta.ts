import { loadBsdiff, loadBspatch } from "bsdiff-wasm";

export async function createVerifiedPatch(oldBytes: Uint8Array, newBytes: Uint8Array) {
  const diff = await loadBsdiff();
  diff.FS.writeFile("/old", new Uint8Array(oldBytes));
  diff.FS.writeFile("/new", new Uint8Array(newBytes));
  const result = diff.callMain(["/old", "/new", "/patch"]);
  if (result !== 0) throw new Error("bsdiff failed");
  const patch = diff.FS.readFile("/patch").slice();
  const apply = await loadBspatch();
  apply.FS.writeFile("/old", new Uint8Array(oldBytes));
  apply.FS.writeFile("/patch", patch);
  if (apply.callMain(["/old", "/new", "/patch"]) !== 0) throw new Error("bspatch failed");
  const restored = apply.FS.readFile("/new");
  if (!Buffer.from(restored).equals(Buffer.from(newBytes))) throw new Error("Patch verification failed");
  return patch;
}
