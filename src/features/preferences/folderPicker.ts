import { open } from '@tauri-apps/plugin-dialog'
import { inTauri } from '@/app/coreClient'

/**
 * Native folder dialog (multi-select). Returns [] when the user cancels, and
 * also outside Tauri, where there is no dialog: callers offer manual input.
 */
export async function pickFolders(): Promise<string[]> {
  if (!inTauri()) return []
  const result = await open({
    directory: true,
    multiple: true,
    title: 'Carpetas que el asistente puede leer',
  })
  if (!result) return []
  return Array.isArray(result) ? result : [result]
}
