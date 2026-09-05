import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { catalog, queryKeys, type CatalogItem, type ItemKind } from '@twentyfour/api'
import { CatalogItemDialog } from './CatalogItemDialog'
import { useTerms } from '@twentyfour/terms'
import { usePermission } from '@twentyfour/rbac'
import {
  Badge, Button, Card, EmptyState, ErrorState, Icon, Input, MoneyText, Select,
  Skeleton, Table, TableScroll, Td, Th, Tr,
} from '@twentyfour/ui'

/**
 * The catalog, on the device that sells from it.
 *
 * Every visible noun comes from the term set, so a restaurant reads Menu and
 * Dish while a hotel reads Room types and Room. The route and the field stay
 * catalog and catalog_item in both, which is what keeps a rename from becoming
 * a migration.
 */
export function CatalogList({ kind }: { kind?: ItemKind }) {
  const terms = useTerms()
  const mayEdit = usePermission('catalog.edit')
  const [search, setSearch] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [editing, setEditing] = useState<CatalogItem | null>(null)
  const [creating, setCreating] = useState(false)

  const categories = useQuery({
    queryKey: queryKeys.catalog.categories(),
    queryFn: catalog.categories,
  })

  const items = useQuery({
    queryKey: queryKeys.catalog.items({ search, categoryId, kind }),
    queryFn: () =>
      catalog.items({
        ...(search ? { search } : {}),
        ...(categoryId ? { categoryId } : {}),
        ...(kind ? { kind } : {}),
      }),
  })

  const itemWord = terms.t('catalog_item', { case: 'lower' })
  const showDuration = kind === 'service'

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Input
          className="sm:max-w-xs"
          type="search"
          placeholder={`Search ${terms.t('catalog_item', { plural: true, case: 'lower' })}`}
          iconStart="Search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label={`Search ${terms.t('catalog_item', { plural: true, case: 'lower' })}`}
        />
        <Select
          className="sm:max-w-xs"
          value={categoryId}
          onChange={(event) => setCategoryId(event.target.value)}
          aria-label={terms.t('catalog_category')}
        >
          <option value="">
            All {terms.t('catalog_category', { plural: true, case: 'lower' })}
          </option>
          {(categories.data ?? []).map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </Select>
        {mayEdit && (
          <Button className="sm:ml-auto" iconStart="Plus" onClick={() => setCreating(true)}>
            Add {itemWord}
          </Button>
        )}
      </div>

      {items.isError ? (
        <ErrorState
          description={`Your ${terms.t('catalog', { case: 'lower' })} did not load. Nothing has been changed.`}
          onRetry={() => void items.refetch()}
        />
      ) : items.isPending ? (
        <Card padded={false}>
          <div className="flex flex-col gap-3 p-5">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-11 w-full" />
            ))}
          </div>
        </Card>
      ) : items.data.length === 0 ? (
        <EmptyState
          icon="LayoutGrid"
          title={`No ${terms.t('catalog_item', { plural: true, case: 'lower' })} match that`}
          description="Clear the search or the category filter to see everything again."
          action={
            <Button
              variant="outline"
              onClick={() => {
                setSearch('')
                setCategoryId('')
              }}
            >
              Clear filters
            </Button>
          }
        />
      ) : (
        <Card padded={false}>
          <TableScroll>
            <Table>
              <thead>
                <tr>
                  <Th>{terms.t('catalog_item')}</Th>
                  <Th className="hidden sm:table-cell">SKU</Th>
                  <Th className="hidden md:table-cell">{terms.t('catalog_category')}</Th>
                  {showDuration && <Th className="hidden lg:table-cell">{terms.t('duration')}</Th>}
                  <Th numeric>Tax</Th>
                  <Th numeric>Price</Th>
                  {mayEdit && <Th />}
                </tr>
              </thead>
              <tbody>
                {items.data.map((item) => (
                  <Tr
                    key={item.id}
                    interactive={mayEdit}
                    onClick={mayEdit ? () => setEditing(item) : undefined}
                  >
                    <Td>
                      <span className="flex items-center gap-2.5">
                        <span
                          aria-hidden="true"
                          className="h-6 w-1 shrink-0 rounded-full"
                          style={{ backgroundColor: item.colour ?? 'var(--border-strong)' }}
                        />
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-text">{item.name}</span>
                          <span className="block truncate text-sm text-text-subtle sm:hidden">
                            {item.sku}
                          </span>
                        </span>
                        {item.trackStock && (
                          <Badge tone="neutral" icon="Boxes" className="ml-1 hidden sm:inline-flex">
                            Stocked
                          </Badge>
                        )}
                      </span>
                    </Td>
                    <Td className="hidden font-mono text-sm text-text-muted sm:table-cell">
                      {item.sku}
                    </Td>
                    <Td className="hidden text-text-muted md:table-cell">
                      {categories.data?.find((category) => category.id === item.categoryId)?.name ??
                        '—'}
                    </Td>
                    {showDuration && (
                      <Td className="hidden text-text-muted lg:table-cell">
                        {item.durationMinutes > 0 ? `${item.durationMinutes} min` : '—'}
                      </Td>
                    )}
                    <Td numeric className="text-text-muted">
                      {item.taxBasisPoints / 100}%
                    </Td>
                    <Td numeric className="font-medium">
                      <MoneyText value={item.unitPrice} />
                      {/* Whether the figure is gross or net is not cosmetic: a
                          merchant reading it the wrong way misprices a whole
                          catalog, so it is stated on every row. */}
                      <span className="ml-1.5 text-xs font-normal text-text-subtle">
                        {item.taxIncluded ? 'inc' : 'ex'}
                      </span>
                    </Td>
                    {mayEdit && (
                      <Td className="text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          iconStart="Pencil"
                          onClick={(event) => {
                            event.stopPropagation()
                            setEditing(item)
                          }}
                        >
                          <span className="sr-only">Edit {item.name}</span>
                        </Button>
                      </Td>
                    )}
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        </Card>
      )}

      {!mayEdit && (
        <p className="flex items-center gap-2 text-sm text-text-subtle">
          <Icon name="Info" size="sm" />
          You can see prices but not change them. Ask an owner or a manager.
        </p>
      )}

      <CatalogItemDialog item={editing} open={editing !== null} onClose={() => setEditing(null)} />
      <CatalogItemDialog item={null} open={creating} onClose={() => setCreating(false)} />
    </div>
  )
}
