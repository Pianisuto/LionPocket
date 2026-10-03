/** Visual fixture only. This is not protocol/authentication evidence. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { SyncPanel } from '../../apps/desktop/src/ui/SyncPanel';
import '../../apps/desktop/src/index.css';
let status: { activity: string; phase: string; endpoint: string; discovered: { oidc: { issuer: string } } | null; sync: null; reviews: never[]; quarantine: never[]; devices: never[]; owner: boolean; invitation: string; lastCompletedAt: string | null } = { activity: 'local', phase: 'local', endpoint: '', discovered: null, sync: null, reviews: [], quarantine: [], devices: [], owner: false, invitation: '', lastCompletedAt: null };
const recovery = new URLSearchParams(window.location.search).get('recovery');
if (recovery) Object.assign(status, {phase:'bound',activity:recovery==='recovered'?'synced':'paused',owner:true,anchorRecoveryAvailable:true,
  recoveryPhase:recovery,compatibilityMessage:null,endpoint:'https://sync.fixture.test',discovered:{oidc:{issuer:'https://auth.fixture.test/realms/lionpocket'}}});
const fixtureRecovery = 'LP1.VISUAL_FIXTURE_ONLY_NEVER_A_REAL_RECOVERY';
const api = {
  syncStatus: async () => status,
  onSyncChanged: () => () => {},
  syncCommand: async (action: string, args: unknown[]) => {
    if (action === 'configure') status = { ...status, endpoint: String(args[0]), discovered: { oidc: { issuer: 'https://auth.fixture.test/realms/lionpocket' } } } as typeof status;
    if (action === 'create') status = { ...status, phase: 'recovery', activity: 'configuring', owner: true, invitation: 'Convite fictício copiável para recuperação' };
    if (action === 'recovery-generate') return { code: fixtureRecovery };
    if (action === 'recovery-confirm') status = { ...status, phase: 'bound', activity: 'synced', lastCompletedAt: new Date().toISOString() } as typeof status;
    return [];
  },
};
Object.assign(window, { lionPocket: api });
createRoot(document.getElementById('root')!).render(<main style={{ padding: '32px', maxWidth: 950, margin: 'auto' }}><SyncPanel onChanged={async () => {}} /></main>);
