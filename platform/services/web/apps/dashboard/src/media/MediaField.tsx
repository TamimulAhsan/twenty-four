import { useCallback, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { media, queryKeys, uploadFile, HttpError, type MediaFile, type MediaPurpose } from '@twentyfour/api'
import { Button, Card, Icon, Spinner, cn, useToast } from '@twentyfour/ui'

/**
 * Files, attached to something.
 *
 * The upload is three steps and none of them is a form post: the browser asks
 * for somewhere to put the file, PUTs it straight to storage, and then says it
 * finished. That is visible here because it has to be, and it is the reason a
 * merchant uploading forty product photographs does not put forty photographs
 * through the API.
 *
 * What it will not do is optimistic anything. A file is not on the screen until
 * the service has confirmed it exists, because the failure this guards against
 * is a merchant seeing their logo, navigating away, and finding it gone: the
 * upload having succeeded and the confirmation not is exactly the case the
 * service sweeps away later.
 */
export function MediaField({
  purpose,
  subjectType,
  subjectId,
  label,
  hint,
  max = 1,
  disabled = false,
}: {
  purpose: MediaPurpose
  subjectType?: string
  subjectId?: string
  label: string
  hint?: string
  /** One for a logo, more for a gallery. */
  max?: number
  disabled?: boolean
}) {
  const filters = { purpose, subjectType, subjectId }
  const client = useQueryClient()
  const toast = useToast()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  const files = useQuery({
    queryKey: queryKeys.media.list(filters),
    queryFn: () => media.list(filters),
  })

  const invalidate = useCallback(() => {
    void client.invalidateQueries({ queryKey: queryKeys.media.list(filters) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, purpose, subjectType, subjectId])

  const upload = useMutation({
    mutationFn: (file: File) => uploadFile(file, { purpose, subjectType, subjectId }),
    onSuccess: () => {
      invalidate()
      toast.show({ tone: 'success', title: 'Uploaded' })
    },
    onError: (err) => {
      // The refusal comes from the service and is written for a merchant:
      // "an SVG is not a kind of file that can be used here" is more use than
      // anything this component could invent about it.
      toast.show({
        tone: 'danger',
        title: 'That file was not accepted',
        description: err instanceof HttpError ? err.message : undefined,
      })
    },
    onSettled: () => setBusy(false),
  })

  const remove = useMutation({
    mutationFn: (id: string) => media.remove(id),
    onSuccess: () => {
      invalidate()
      toast.show({ tone: 'success', title: 'Removed' })
    },
  })

  const list = files.data ?? []
  const full = list.length >= max

  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <p className="text-base font-medium text-text">{label}</p>
          {hint && <p className="mt-0.5 text-sm text-text-subtle">{hint}</p>}
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled || full || busy}
          onClick={() => input.current?.click()}
        >
          {busy ? <Spinner /> : <Icon name="Upload" size="sm" />}
          {max === 1 && list.length === 1 ? 'Replace' : 'Add'}
        </Button>
      </div>

      <input
        ref={input}
        type="file"
        className="hidden"
        // Advisory only. The service decides what it will sign for, and it
        // refuses an SVG whatever a file picker was willing to offer.
        accept="image/png,image/jpeg,image/webp,image/avif"
        onChange={(e) => {
          const file = e.target.files?.[0]
          // Cleared straight away so choosing the same file twice still fires.
          e.target.value = ''
          if (!file) return
          setBusy(true)
          const replacing = max === 1 ? list[0] : undefined
          if (replacing) {
            // Replacing, not accumulating. The old one goes only after the new
            // one lands, so a failed upload never leaves the merchant with
            // nothing where their logo used to be.
            upload.mutate(file, { onSuccess: () => remove.mutate(replacing.id) })
            return
          }
          upload.mutate(file)
        }}
      />

      <div className={cn('mt-3 grid gap-3', max > 1 ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-1')}>
        {list.map((file) => (
          <MediaThumb
            key={file.id}
            file={file}
            onRemove={disabled ? undefined : () => remove.mutate(file.id)}
          />
        ))}
        {list.length === 0 && !files.isLoading && (
          <Card className="border-dashed py-8 text-center text-sm text-text-subtle">
            Nothing uploaded yet.
          </Card>
        )}
      </div>
    </div>
  )
}

/**
 * One file, shown.
 *
 * The link is fetched per file rather than held in the list, because a signed
 * URL expires: one cached with the list would render as a broken image an hour
 * later, which reads as data loss rather than as a link that timed out.
 */
function MediaThumb({ file, onRemove }: { file: MediaFile; onRemove?: () => void }) {
  const link = useQuery({
    queryKey: queryKeys.media.url(file.id),
    queryFn: () => media.url(file.id),
    enabled: file.ready,
    // Short, and well inside the hour the service signs for.
    staleTime: 5 * 60 * 1000,
  })

  return (
    <Card padded={false} className="group relative overflow-hidden">
      {file.ready && link.data ? (
        <img src={link.data.url} alt={file.filename} className="h-28 w-full object-contain bg-surface-sunken" />
      ) : (
        <div className="flex h-28 items-center justify-center bg-surface-sunken text-text-subtle">
          {/* A record exists from the moment a URL is signed, which is before
              any bytes arrive. Saying so beats showing a broken image. */}
          {file.ready ? <Spinner /> : <span className="text-sm">Not finished uploading</span>}
        </div>
      )}
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="truncate text-sm text-text-subtle" title={file.filename}>
          {file.filename}
        </span>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove ${file.filename}`}
            className="shrink-0 text-text-subtle transition-colors hover:text-danger"
          >
            <Icon name="Trash2" size="sm" />
          </button>
        )}
      </div>
    </Card>
  )
}
