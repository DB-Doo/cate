import { app } from 'electron'

// In production the asar archive can't be used to spawn child processes, so
// electron-builder unpacks @earendil-works/** via asarUnpack. The unpacked
// files live at app.asar.unpacked/ next to app.asar.
export function unpackedAppPath(): string {
  const p = app.getAppPath()
  return p.includes('app.asar') ? p.replace('app.asar', 'app.asar.unpacked') : p
}
