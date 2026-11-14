import { getPrefsStore } from '../prefs/store.ts'
import { captureBlock, type CaptureBlock } from './gate.ts'
import { PLATFORMS, type PlatformKey } from './platforms.ts'

// The audio itself never goes through GraphQL (ADR 0002 / 0009): this only tells the UI whether capture is
// allowed and which platform names exist. Starting and stopping happens over `WS /capture` from the shell.
// oxlint-disable-next-line typescript/no-explicit-any
type AnyBuilder = PothosSchemaTypes.SchemaBuilder<any>

export function registerCapture(builder: AnyBuilder): void {
  const Status = builder
    .objectRef<{ allowed: boolean; block: CaptureBlock | null }>(
      'CaptureStatus',
    )
    .implement({
      fields: (t) => ({
        allowed: t.exposeBoolean('allowed'),
        // 'env' | 'disabled' | 'consent' when blocked.
        block: t.exposeString('block', { nullable: true }),
      }),
    })
  const Platform = builder
    .objectRef<{ key: PlatformKey; label: string }>('CapturePlatform')
    .implement({
      fields: (t) => ({
        key: t.exposeString('key'),
        label: t.exposeString('label'),
      }),
    })

  builder.queryFields((t) => ({
    captureStatus: t.field({
      type: Status,
      resolve: () => {
        const block = captureBlock(getPrefsStore().get().capture)
        return { allowed: block === null, block }
      },
    }),
    capturePlatforms: t.field({
      type: [Platform],
      resolve: () =>
        (Object.keys(PLATFORMS) as PlatformKey[]).map((key) => ({
          key,
          label: PLATFORMS[key],
        })),
    }),
  }))
}
