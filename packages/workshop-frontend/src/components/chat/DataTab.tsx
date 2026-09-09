import { useTranslation, renderTranslation, getLocale } from "@gadgets/i18n";
import { useState } from 'react'
import { Table } from '@cloudflare/kumo'
import { Badge } from '@cloudflare/kumo'
import { Button } from '@cloudflare/kumo'
import { sampleDataRows } from '../../data/chat'

export default function DataTab() {
  const { t } = useTranslation();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  function toggleRow(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    if (selectedIds.size === sampleDataRows.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(sampleDataRows.map((r) => r.id)))
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-kumo-fill bg-kumo-elevated">
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm text-kumo-default">{t("workshop-frontend.DataTab.channels")}</span>
          <Badge variant="secondary">{renderTranslation(t("workshop-frontend.DataTab.rows_2"), { length: sampleDataRows.length })}</Badge>
        </div>
        <div className="flex items-center gap-2">
          {selectedIds.size > 0 && (
            <span className="text-xs text-kumo-subtle">
              {renderTranslation(t("workshop-frontend.DataTab.selected_2"), { size: selectedIds.size })}</span>
          )}
          <Button variant="ghost" size="xs">{t("workshop-frontend.DataTab.filter")}</Button>
          <Button variant="ghost" size="xs">{t("workshop-frontend.DataTab.sort")}</Button>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <Table layout="fixed">
          <Table.Header>
            <Table.Row>
              <Table.CheckHead
                checked={selectedIds.size === sampleDataRows.length}
                indeterminate={selectedIds.size > 0 && selectedIds.size < sampleDataRows.length}
                onValueChange={toggleAll}
                aria-label={t("workshop-frontend.DataTab.select_all_rows")}
              />
              <Table.Head>{t("workshop-frontend.DataTab.channel")}</Table.Head>
              <Table.Head>{t("workshop-frontend.DataTab.messages")}</Table.Head>
              <Table.Head>{t("workshop-frontend.DataTab.last_active")}</Table.Head>
              <Table.Head>{t("workshop-frontend.DataTab.status")}</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {sampleDataRows.map((row) => (
              <Table.Row key={row.id} variant={selectedIds.has(row.id) ? 'selected' : 'default'}>
                <Table.CheckCell
                  checked={selectedIds.has(row.id)}
                  onValueChange={() => toggleRow(row.id)}
                  aria-label={t("workshop-frontend.DataTab.select", { value1: row.channel })}
                />
                <Table.Cell>
                  <span className="font-mono text-sm text-kumo-default">{row.channel}</span>
                </Table.Cell>
                <Table.Cell>
                  <span className="text-sm text-kumo-subtle tabular-nums">
                    {row.messages.toLocaleString(getLocale())}
                  </span>
                </Table.Cell>
                <Table.Cell>
                  <span className="text-xs text-kumo-subtle">{row.lastActive}</span>
                </Table.Cell>
                <Table.Cell>
                  {row.unread ? (
                    <Badge variant="primary">{t("workshop-frontend.DataTab.unread")}</Badge>
                  ) : (
                    <Badge variant="secondary">{t("workshop-frontend.DataTab.read")}</Badge>
                  )}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-kumo-fill bg-kumo-elevated flex items-center justify-between">
        <span className="font-mono text-xs text-kumo-subtle">
          {renderTranslation(t("workshop-frontend.DataTab.rows_in_channels_2"), { length: sampleDataRows.length })}</span>
        <span className="font-mono text-xs text-kumo-subtle">
          {renderTranslation(t("workshop-frontend.DataTab.total_messages_2"), { value: sampleDataRows.reduce((sum, r) => sum + r.messages, 0).toLocaleString(getLocale()) })}</span>
      </div>
    </div>
  )
}
