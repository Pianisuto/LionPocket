import { revisionSummary } from '@lionpocket/sync-local';
import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { Button } from '../../components';
import { SyncCard, SyncCheck, SyncDisclosure, SyncNotice, useSyncStyles } from './kit';
import type { SyncSession } from './useSyncSession';

/** Decisions the user must take before sync can finish. */
export function SyncReviews({ status, busy, act }: SyncSession) {
  const styles = useSyncStyles();
  const [reviewed, setReviewed] = useState(false);
  const [details, setDetails] = useState('');
  return (
    <>
      {status.restoreReview && (
        <SyncCard
          icon="shield"
          title="Revise a cópia restaurada"
          description="Reconecte no mesmo aparelho, cofre e histórico do servidor. As diferenças locais serão rascunhos; receba e revise o remoto antes de liberar envio."
        >
          <SyncCheck
            label="Revisei a cópia restaurada"
            checked={reviewed}
            disabled={busy}
            onChange={setReviewed}
          />
          <Button
            label="Reconectar cópia para revisão"
            tone="primary"
            disabled={busy || !reviewed}
            onPress={() => act((c) => c.reconnectRestored(true))}
          />
        </SyncCard>
      )}
      {status.sync?.conflicts.map((c) => (
        <SyncCard
          key={c.objectId}
          icon="sync"
          title="Escolha a versão deste registro"
          description="Este lançamento foi alterado em mais de um aparelho. Compare e escolha qual versão conservar."
        >
          {c.branches.map((b) => {
            const summary = revisionSummary(b.revision);
            const restore = c.deleted && b.revision.action === 'put';
            return (
              <View key={b.revisionId} style={[styles.card, { gap: 8 }]}>
                <Text style={styles.strong}>{summary.title}</Text>
                {summary.lines.map((line, index) => (
                  <Text style={styles.text} key={index}>
                    {line}
                  </Text>
                ))}
                <Text style={styles.muted}>
                  Alterado em{' '}
                  {new Date(b.revision.authoredAt).toLocaleString('pt-BR')}
                </Text>
                <SyncDisclosure
                  icon="data"
                  title="Detalhes desta versão"
                  open={details === b.revisionId}
                  onToggle={() =>
                    setDetails(details === b.revisionId ? '' : b.revisionId)
                  }
                >
                  <Text style={styles.muted} selectable>
                    {JSON.stringify(b.revision, null, 2)}
                  </Text>
                </SyncDisclosure>
                <Button
                  label={
                    restore
                      ? 'Recuperar como novo registro'
                      : b.revision.action === 'delete'
                        ? 'Confirmar exclusão'
                        : 'Usar esta versão'
                  }
                  disabled={busy}
                  onPress={() =>
                    act((controller) =>
                      controller.resolve(c.objectId, c.heads, b.revisionId, restore),
                    )
                  }
                />
              </View>
            );
          })}
        </SyncCard>
      ))}
      {status.reviews
        .filter((r) => r.reason === 'restored_missing_record')
        .map((r) => (
          <SyncCard
            key={String(r.review_id)}
            icon="shield"
            title="Confira um registro ausente na cópia restaurada"
            description="A cópia restaurada não contém este registro. Confirme a exclusão somente se deseja removê-lo dos outros aparelhos."
          >
            <Button
              disabled={busy}
              label="Confirmar exclusão agora"
              onPress={() =>
                act((c) => c.confirmLegacyDeletion(String(r.object_id), true))
              }
            />
          </SyncCard>
        ))}
      {!!(status.reviews.length || status.quarantine.length) && (
        <SyncNotice tone="warning" title="Há informações para revisar">
          {!!status.reviews.length &&
            `${status.reviews.length} registro(s) precisam de revisão antes de concluir a sincronização. `}
          {!!status.quarantine.length &&
            'Alguns recebimentos foram preservados para revisão. Seus dados locais continuam disponíveis.'}
        </SyncNotice>
      )}
    </>
  );
}

/** Technical identifiers, collapsed by default. */
export function SyncDiagnostics({ status }: SyncSession) {
  const styles = useSyncStyles();
  const [open, setOpen] = useState(false);
  if (!status.reviews.length && !status.quarantine.length) return null;
  return (
    <SyncDisclosure
      icon="data"
      title="Diagnóstico das revisões"
      description="Identificadores técnicos das revisões e recebimentos preservados."
      open={open}
      onToggle={() => setOpen(!open)}
    >
      {status.reviews.map((r) => (
        <Text key={String(r.review_id)} style={styles.muted} selectable>
          {String(r.reason)} · {String(r.object_id)}
        </Text>
      ))}
      {status.quarantine.map((q) => (
        <Text key={String(q.commit_id)} style={styles.muted} selectable>
          {String(q.last_error)}
        </Text>
      ))}
    </SyncDisclosure>
  );
}
