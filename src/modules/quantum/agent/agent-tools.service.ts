import { BadRequestException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { FirebaseAdminService } from '../../firebase-admin/firebase-admin.service';
import { QuantumAgentDataService } from './agent-data.service';
import { identifier } from './agent-validation';

type Tool = { id: string; slug: string; name: string; toolkit_slug: string; composio_auth_config_id?: string | null; [key: string]: unknown };
const DEFAULT_TOOLS = [
  ['gmail', 'Gmail'], ['slack', 'Slack'], ['instagram', 'Instagram'],
  ['googlesheets', 'Google Sheets'], ['googledocs', 'Google Docs'],
  ['outlook', 'Outlook'], ['youtube', 'YouTube'],
].map(([slug, name], sort_order) => ({
  id: slug, slug, name, toolkit_slug: slug, sort_order, is_active: true,
  description: `Connect ${name} to Quantum`, category: 'Productivity', actions: [],
  logo_url: null, icon_url: null, logo_key: slug,
}));

@Injectable()
export class QuantumAgentToolsService {
  constructor(
    @Inject(FirebaseAdminService) private readonly firebase: FirebaseAdminService,
    @Inject(QuantumAgentDataService) private readonly data: QuantumAgentDataService,
  ) {}
  private async client() {
    if (!process.env.COMPOSIO_API_KEY) throw new ServiceUnavailableException('Tool connections are not configured.');
    const { Composio } = await import('@composio/core');
    return new Composio({ apiKey: process.env.COMPOSIO_API_KEY });
  }
  private connections(uid: string) { return this.data.user(uid).collection('connections'); }
  async catalog(): Promise<Tool[]> {
    const rows = await this.firebase.db().collection('quantum_agent_tools').get();
    const tools: Tool[] = rows.empty ? DEFAULT_TOOLS : rows.docs.map(row => ({ ...row.data(), id: row.id } as Tool));
    return tools.filter(tool => tool.is_active !== false).sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0));
  }
  private async tool(id: string) {
    identifier(id);
    const tool = (await this.catalog()).find(item => item.id === id || item.slug === id);
    if (!tool) throw new NotFoundException('Tool not found.');
    return tool;
  }
  async list(uid: string) {
    const [tools, connections] = await Promise.all([this.catalog(), this.connections(uid).get()]);
    const byId = new Map(connections.docs.map(row => [row.id, row.data()]));
    return tools.map(tool => {
      const connection = byId.get(tool.id);
      return { ...tool, status: connection?.status || 'not_connected', connected_label: connection?.connected_label || null, connected_email: connection?.connected_email || null, composio_connected_account_id: connection?.composio_connected_account_id || null };
    });
  }
  private async ownedAccounts(uid: string) {
    const client = await this.client();
    const rows = await client.connectedAccounts.list({ userIds: [uid] });
    return rows.items;
  }
  private matches(account: any, tool: Tool) {
    return account.toolkit?.slug?.toLowerCase() === tool.toolkit_slug.toLowerCase()
      || (!!tool.composio_auth_config_id && account.authConfig?.id === tool.composio_auth_config_id);
  }
  private async save(uid: string, tool: Tool, status: string, account?: any, requestId?: string) {
    const now = new Date().toISOString();
    const email = account?.userEmail || account?.email || account?.data?.email || null;
    const row = {
      id: tool.id, user_id: uid, tool_id: tool.id, status,
      composio_connected_account_id: account?.id || null,
      composio_connection_request_id: requestId || null,
      connected_label: account?.label || email,
      connected_email: email, updated_at: now, last_checked_at: now,
      connected_at: status === 'connected' ? now : null,
    };
    await this.connections(uid).doc(tool.id).set(row, { merge: true });
    return row;
  }
  async connect(uid: string, id: string, callbackUrl?: unknown) {
    const tool = await this.tool(id);
    if (callbackUrl && callbackUrl !== 'quantum://tools' && callbackUrl !== 'https://quantum.chefu.co.za/tools') {
      throw new BadRequestException('Invalid tool callback URL.');
    }
    const composio = await this.client();
    const active = (await this.ownedAccounts(uid)).find(account => account.status === 'ACTIVE' && this.matches(account, tool));
    if (active) {
      await this.save(uid, tool, 'connected', active);
      return { success: true, toolId: tool.id, toolName: tool.name, connectUrl: '', connectionRequestId: active.id, composioConnectedAccountId: active.id, status: 'connected' };
    }
    let authConfigId = tool.composio_auth_config_id || process.env[`COMPOSIO_AUTH_CONFIG_${tool.slug.toUpperCase()}`];
    if (!authConfigId) {
      const configs = await composio.authConfigs.list({ toolkit: tool.toolkit_slug });
      authConfigId = configs.items[0]?.id;
    }
    if (!authConfigId) throw new ServiceUnavailableException(`No auth configuration for ${tool.name}.`);
    const request = await composio.connectedAccounts.link(uid, authConfigId, { allowMultiple: false, ...(callbackUrl ? { callbackUrl: String(callbackUrl) } : {}) });
    await this.save(uid, tool, 'pending', { id: request.id }, request.id);
    return { success: true, toolId: tool.id, toolName: tool.name, connectUrl: request.redirectUrl || '', connectionRequestId: request.id, composioConnectedAccountId: request.id, status: 'pending' };
  }
  async status(uid: string, id: string) {
    const tool = await this.tool(id);
    const accounts = (await this.ownedAccounts(uid)).filter(account => this.matches(account, tool));
    const account = accounts.find(item => item.status === 'ACTIVE') || accounts[0];
    const status = account?.status === 'ACTIVE' ? 'connected' : !account ? 'not_connected'
      : ['FAILED', 'ERROR'].includes(account.status) ? 'failed'
      : ['REVOKED', 'EXPIRED', 'DISABLED'].includes(account.status) ? 'revoked' : 'pending';
    const row = await this.save(uid, tool, status, account);
    return { success: true, toolId: tool.id, status, connectedLabel: row.connected_label, connectedEmail: row.connected_email, composioConnectedAccountId: row.composio_connected_account_id, composioConnectionRequestId: row.composio_connection_request_id, lastCheckedAt: row.last_checked_at };
  }
  async disconnect(uid: string, id: string) {
    const tool = await this.tool(id);
    // Only delete accounts returned for the authenticated user's Composio ID.
    const accounts = (await this.ownedAccounts(uid)).filter(account => this.matches(account, tool));
    const client = await this.client();
    for (const account of accounts) await client.connectedAccounts.delete(account.id);
    await this.save(uid, tool, 'revoked');
    return { success: true, toolId: tool.id, status: 'revoked', message: 'Tool disconnected.' };
  }
}
