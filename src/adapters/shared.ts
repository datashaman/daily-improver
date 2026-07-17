import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

export async function exists(root: string, file: string): Promise<boolean> {
  try {
    await access(join(root, file), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(root: string, file: string): Promise<T> {
  return JSON.parse(await readFile(join(root, file), "utf8")) as T;
}
