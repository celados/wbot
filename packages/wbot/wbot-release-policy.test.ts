import type { Server } from 'node:http'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import { createPlatformClient } from './platform-client'
import {
	createAccountFixture,
	createConversationFixture,
	createIdentityFixture,
	createMessageFixture,
} from './platform-v2-fixtures'
import {
	extractChangelogSection,
	requireMatchingReleaseVersions,
	readReleaseImpact,
	requireVersionIncrement,
} from './scripts/release-preflight'

const packageRoot = new URL('.', import.meta.url).pathname
const repositoryRoot = join(packageRoot, '../..')
const cliEntry = join(packageRoot, 'wbot-cli.ts')
const servers: Array<Server> = []
const temporaryDirectories: Array<string> = []

const createFixture = async () => {
	const packageJson = await readJson(join(packageRoot, 'package.json'))
	return {
		expectedVersion: String(packageJson.version),
		packageJson,
	}
}

afterEach(async () => {
	await Promise.all([
		...servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve, reject) => {
					server.close((error) =>
						error === undefined ? resolve() : reject(error),
					)
				}),
		),
		...temporaryDirectories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	])
})

describe('功能 1：所有公开入口共享一个发布身份', () => {
	test('场景 1.1：发布者得到一致的版本产物', async () => {
		const fixture = await createFixture()
		const cli = await runCli(['--version'])
		const mcp = await createStdioMcpFixture()
		const codexManifest = await readJson(
			join(repositoryRoot, 'plugins/codex/wbot/.codex-plugin/plugin.json'),
		)
		const claudeManifest = await readJson(
			join(repositoryRoot, 'plugins/claude/wbot/.claude-plugin/plugin.json'),
		)
		const marketplace = await readJson(
			join(repositoryRoot, 'plugins/claude/.claude-plugin/marketplace.json'),
		)
		const codexMcp = await readJson(
			join(repositoryRoot, 'plugins/codex/wbot/.mcp.json'),
		)
		const claudeMcp = await readJson(
			join(repositoryRoot, 'plugins/claude/wbot/.mcp.json'),
		)

		expect(cli.exitCode, cli.stderr).toBe(0)
		expect(cli.stdout.trim()).toContain(fixture.expectedVersion)
		expect(mcp.client.getServerVersion()?.version).toBe(fixture.expectedVersion)
		expect(codexManifest.version).toBe(fixture.expectedVersion)
		expect(claudeManifest.version).toBe(fixture.expectedVersion)
		expect(marketplace.plugins[0]?.version).toBe(fixture.expectedVersion)
		expect(readPinnedVersion(codexMcp)).toBe(fixture.expectedVersion)
		expect(readPinnedVersion(claudeMcp)).toBe(fixture.expectedVersion)

		await mcp.close()
	})

	test('场景 1.2：任一入口版本漂移时阻止发布', () => {
		expect(() =>
			requireMatchingReleaseVersions('0.2.0-rc.1', [
				{ name: 'Codex Plugin', version: '0.1.2' },
				{ name: 'Claude Plugin', version: '0.2.0-rc.1' },
			]),
		).toThrow('Codex Plugin reports 0.1.2, expected 0.2.0-rc.1')
	})
})

describe('功能 3：每个发布版本都有可迁移的变更记录', () => {
	test('场景 3.1：版本变化必须存在同名 changelog 章节', async () => {
		const changelog = `# Changelog

## Unreleased

## 0.2.0-rc.1 - 2026-08-11

### Breaking Changes

- Conversation results now require capture freshness.

### Migration

- Read the new capture freshness field.

## 0.1.2 - 2026-08-09

### Fixed

- Unified the public executable.
`

		expect(extractChangelogSection(changelog, '0.2.0-rc.1')).toContain(
			'### Breaking Changes',
		)
		expect(() => extractChangelogSection(changelog, '0.2.0')).toThrow(
			'Changelog must contain version 0.2.0',
		)

		const workflow = await readFile(
			join(repositoryRoot, '.github/workflows/release.yml'),
			'utf8',
		)
		expect(workflow).toContain('release-notes.ts')
		expect(workflow).toContain('-F body=@"$RELEASE_NOTES"')
		expect(workflow).not.toContain('generate_release_notes=true')
	})

	test('场景 3.2：安装产物携带完整版本历史', async () => {
		const fixture = await createFixture()
		const changelog = await readFile(join(packageRoot, 'CHANGELOG.md'), 'utf8')

		for (const version of [
			'0.1.0',
			'0.1.1',
			'0.1.2',
			fixture.expectedVersion,
		]) {
			expect(extractChangelogSection(changelog, version)).toContain(
				`## ${version}`,
			)
		}
		expect(fixture.packageJson.files).toContain('CHANGELOG.md')
	})
})

describe('message evolution never stalls a valid page', () => {
	test.each(['group_invitation', 'future_poll'])(
		'CLI and MCP retain %s and its cursor',
		async (kind) => {
			const content =
				kind === 'future_poll'
					? { kind, options: ['one', 'two'] }
					: { kind, members: [createIdentityFixture('member-1')] }
			const message = createMessageFixture({
				content,
				revision: 1,
				referenceId: 'reference-1',
				attachment: undefined,
				replyTo: {
					messageId: null,
					sender: null,
					occurredAtMs: null,
					state: 'active',
					content,
				},
			})
			const expectedContent =
				kind === 'future_poll'
					? {
							kind: 'unknown',
							preview: 'Unsupported message type',
							originalKind: kind,
							originalContent: content,
						}
					: content
			const expectedMessage = {
				content: expectedContent,
				revision: 1,
				referenceId: 'reference-1',
				replyTo: { content: expectedContent },
			}
			const url = await createRoutedPlatformServer({
				messages: {
					items: [message],
					nextCursor: 'cursor-after-notice',
					hasMore: true,
				},
				changes: {
					items: [
						{
							sequence: 7,
							kind: 'message.created',
							occurredAtMs: 1_786_000_000_000,
							message,
						},
					],
					nextCursor: 'cursor-after-notice',
					hasMore: true,
				},
				conversations: {
					items: [createConversationFixture({ latestMessage: message })],
				},
			})
			const input = JSON.stringify({
				conversationId: 'conversation-1',
				cursor: 'cursor-before-notice',
			})
			const env = { WBOT_API_KEY: 'fixture-secret', WBOT_PLATFORM_URL: url }
			const history = await runCli(['messages.history', input], env)
			expect(history.exitCode, history.stderr).toBe(0)
			expect(JSON.parse(history.stdout)).toMatchObject({
				items: [expectedMessage],
				nextCursor: 'cursor-after-notice',
				hasMore: true,
			})
			const updates = await runCli(['messages.updates', input], env)
			expect(updates.exitCode, updates.stderr).toBe(0)
			expect(JSON.parse(updates.stdout)).toMatchObject({
				items: [{ sequence: 7, message: expectedMessage }],
				nextCursor: 'cursor-after-notice',
				hasMore: true,
			})
			const mcp = await createStdioMcpFixture({ WBOT_PLATFORM_URL: url })
			try {
				const mcpHistory = await mcp.client.callTool({
					name: 'read_message_history',
					arguments: {
						conversationId: 'conversation-1',
						cursor: 'cursor-before-notice',
					},
				})
				expect(mcpHistory.isError, JSON.stringify(mcpHistory)).not.toBe(true)
				expect(mcpHistory.structuredContent).toMatchObject({
					result: {
						items: [{ content: expectedContent }],
						nextCursor: 'cursor-after-notice',
					},
				})
				const mcpUpdates = await mcp.client.callTool({
					name: 'read_message_updates',
					arguments: {
						conversationId: 'conversation-1',
						cursor: 'cursor-before-notice',
					},
				})
				expect(mcpUpdates.isError, JSON.stringify(mcpUpdates)).not.toBe(true)
				expect(mcpUpdates.structuredContent).toMatchObject({
					result: {
						items: [{ message: { content: expectedContent } }],
						nextCursor: 'cursor-after-notice',
					},
				})
			} finally {
				await mcp.close()
			}
			const list = await runCli(['conversations.list'], env)
			expect(list.exitCode, list.stderr).toBe(0)
			expect(JSON.parse(list.stdout).items[0].latestMessage).toMatchObject({
				content: expectedContent,
			})
		},
	)

	test('a retracted message is a state with null content, not a content kind', async () => {
		const retracted = createMessageFixture({
			state: 'retracted',
			retractedAtMs: 1_786_000_001_000,
			revision: 2,
			content: null,
			attachment: undefined,
		})
		const client = createPlatformClient({
			baseUrl: 'https://platform.example.test',
			tenantApiKey: 'fixture-secret',
			fetch: async () => Response.json(retracted),
		})
		await expect(
			client.getMessage({
				conversationId: 'conversation-1',
				messageId: 'message-1',
			}),
		).resolves.toMatchObject({ state: 'retracted', content: null, revision: 2 })
	})

	test.each([
		{ kind: 'text' },
		{ kind: 'text', text: 42 },
		{ kind: 'unknown' },
		{ kind: 'nudge', suffix: 42, target: null },
		{ kind: 'nudge', suffix: 'hi' },
		{ kind: 'group_invitation' },
		{ kind: 'file', filename: 'a.pdf', sizeBytes: '12' },
		{ kind: '' },
		{ kind: 42 },
		{},
		null,
	])('malformed known content still fails closed: %j', async (content) => {
		const client = createPlatformClient({
			baseUrl: 'https://platform.example.test',
			tenantApiKey: 'fixture-secret',
			fetch: async () =>
				Response.json({
					items: [createMessageFixture({ content })],
					nextCursor: 'next',
					hasMore: false,
				}),
		})
		await expect(
			client.listMessages({ conversationId: 'conversation-1' }),
		).rejects.toMatchObject({ code: 'invalid_platform_response' })
	})
})

describe('功能 4：Agent 只接收符合契约的 Platform 结果', () => {
	test('场景 4.1：未知新增字段不会破坏旧客户端', async () => {
		const client = createPlatformClient({
			baseUrl: 'https://platform.example.test',
			tenantApiKey: 'fixture-secret',
			fetch: async () =>
				Response.json({
					items: [
						createConversationFixture({ futureField: { enabled: true } }),
					],
					futurePageField: 'ignored-or-preserved',
				}),
		})

		const result = await client.listConversations()

		expect(result.items).toHaveLength(1)
		expect(result.items[0]?.id).toBe('conversation-1')

		const accountClient = createPlatformClient({
			baseUrl: 'https://platform.example.test',
			tenantApiKey: 'fixture-secret',
			fetch: async () =>
				Response.json({
					items: [
						createAccountFixture({
							capabilities: ['observe_messages', 'future_capability'],
						}),
					],
				}),
		})
		expect((await accountClient.listAccounts()).items[0]).toMatchObject({
			capabilities: ['observe_messages', 'future_capability'],
			captureFreshness: { status: 'current', asOfMs: 1_786_000_000_000 },
		})

		const messageClient = createPlatformClient({
			baseUrl: 'https://platform.example.test',
			tenantApiKey: 'fixture-secret',
			fetch: async () =>
				Response.json({
					items: [
						{
							sequence: 3,
							kind: 'message.attachment_ready',
							occurredAtMs: 1_786_000_000_000,
							message: createMessageFixture({ futureMessageField: true }),
							futureChangeField: true,
						},
					],
					nextCursor: 'updates-next',
					hasMore: false,
					futurePageField: true,
				}),
		})
		const updates = await messageClient.listChanges({
			conversationId: 'conversation-1',
			cursor: 'updates-cursor',
		})

		expect(updates.items[0]?.message.attachment).toMatchObject({
			status: 'ready',
			descriptor: { kind: 'audio', durationMs: 1250 },
		})
	})

	test('场景 4.2：已知必填数据损坏时明确失败', async () => {
		const client = createPlatformClient({
			baseUrl: 'https://platform.example.test',
			tenantApiKey: 'fixture-secret',
			fetch: async () =>
				new Response(
					JSON.stringify({
						items: [{ id: 'conversation-1', title: 'private-message-content' }],
						nextCursor: 'next',
						hasMore: false,
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } },
				),
		})
		const conversation = { conversationId: 'conversation-1' }

		await expect(client.listAccounts()).rejects.toMatchObject({
			name: 'PlatformContractError',
			code: 'invalid_platform_response',
			endpoint: 'GET /platform/v2/accounts',
		})
		await expect(client.listConversations()).rejects.toMatchObject({
			name: 'PlatformContractError',
			endpoint: 'GET /platform/v2/conversations',
		})
		await expect(client.listChanges(conversation)).rejects.toMatchObject({
			name: 'PlatformContractError',
			endpoint: 'GET /platform/v2/conversations/{id}/changes',
		})
		await expect(client.listMessages(conversation)).rejects.toMatchObject({
			name: 'PlatformContractError',
			endpoint: 'GET /platform/v2/conversations/{id}/messages',
		})
		await expect(
			client.getMessage({ ...conversation, messageId: 'message-1' }),
		).rejects.toMatchObject({
			name: 'PlatformContractError',
			endpoint: 'GET /platform/v2/conversations/{id}/messages/{messageId}',
		})
		await expect(
			client.sendText({
				...conversation,
				requestId: 'request-1',
				text: 'hello',
				requestedBy: 'release-policy-test',
			}),
		).rejects.toMatchObject({
			name: 'PlatformContractError',
			endpoint: 'POST /platform/v2/conversations/{id}/messages',
		})
		await expect(
			client.getOutboundSend({ outboundSendId: 'send-1' }),
		).rejects.toMatchObject({
			name: 'PlatformContractError',
			endpoint: 'GET /platform/v2/outbound-sends/{id}',
		})

		const invalidJsonClient = createPlatformClient({
			baseUrl: 'https://platform.example.test',
			tenantApiKey: 'fixture-secret',
			fetch: async () =>
				new Response('not-json', {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				}),
		})
		await expect(invalidJsonClient.listConversations()).rejects.toMatchObject({
			name: 'PlatformContractError',
			code: 'invalid_platform_response',
			endpoint: 'GET /platform/v2/conversations',
		})

		const invalidMessages = [
			createMessageFixture({
				attachment: {
					status: 'ready',
					url: 'https://media.example/audio.m4a',
					mimeType: 'audio/mp4',
					sizeBytes: 512,
					descriptor: { kind: 'video', durationMs: 1250 },
				},
			}),
			createMessageFixture({ occurredAtMs: '1786000000000' }),
			createMessageFixture({ state: 'retracted' }),
			createMessageFixture({ content: null }),
			createMessageFixture({ mentions: undefined }),
			createMessageFixture({ revision: undefined }),
		]
		for (const message of invalidMessages) {
			const invalidClient = createPlatformClient({
				baseUrl: 'https://platform.example.test',
				tenantApiKey: 'fixture-secret',
				fetch: async () =>
					Response.json({
						items: [
							{
								sequence: 1,
								kind: 'message.created',
								occurredAtMs: 1,
								message,
							},
						],
						nextCursor: 'updates-next',
						hasMore: false,
					}),
			})
			await expect(
				invalidClient.listChanges({
					conversationId: 'conversation-1',
					cursor: 'c',
				}),
			).rejects.toMatchObject({
				name: 'PlatformContractError',
				code: 'invalid_platform_response',
				endpoint: 'GET /platform/v2/conversations/{id}/changes',
			})
		}
	})

	test('场景 4.3：契约错误诊断不泄漏敏感内容', async () => {
		const secretPayload = 'private-message-content'
		const apiKey = 'private-api-key'
		const client = createPlatformClient({
			baseUrl: 'https://platform.example.test',
			tenantApiKey: apiKey,
			fetch: async () =>
				Response.json({
					items: [{ id: 'conversation-1', content: secretPayload }],
					nextCursor: 'next',
					hasMore: false,
				}),
		})

		const error = await client
			.listConversations()
			.catch((caught: unknown) => caught)

		expect(error).toMatchObject({
			name: 'PlatformContractError',
			code: 'invalid_platform_response',
		})
		expect(String(error)).toContain('items.0.channel')
		expect(String(error)).not.toContain(secretPayload)
		expect(String(error)).not.toContain(apiKey)
	})

	test('场景 4.4：Platform 业务错误保持原有错误语义', async () => {
		const client = createPlatformClient({
			baseUrl: 'https://platform.example.test',
			tenantApiKey: 'fixture-secret',
			fetch: async () =>
				Response.json(
					{
						error: {
							code: 'forbidden',
							message: 'Conversation grant is required.',
						},
					},
					{ status: 403 },
				),
		})

		await expect(client.listConversations()).rejects.toMatchObject({
			name: 'PlatformRequestError',
			code: 'forbidden',
			status: 403,
			message: 'Conversation grant is required.',
		})
	})
})

describe('功能 5：API 弃用信息对人和 Agent 都可见', () => {
	test('场景 5.1：弃用警告不污染 CLI JSON', async () => {
		const platformUrl = await createPlatformServer(
			{ items: [createConversationFixture()] },
			{
				Deprecation: '@1788739200',
				Sunset: 'Tue, 08 Dec 2026 00:00:00 GMT',
				Link: '<https://wbot.example/migrate-v2>; rel="deprecation"',
			},
		)

		const result = await runCli(['conversations.list'], {
			WBOT_API_KEY: 'fixture-secret',
			WBOT_PLATFORM_URL: platformUrl,
		})

		expect(result.exitCode, result.stderr).toBe(0)
		expect(JSON.parse(result.stdout)).toMatchObject({
			items: [{ id: 'conversation-1' }],
		})
		expect(result.stderr).toContain('Tue, 08 Dec 2026 00:00:00 GMT')
		expect(result.stderr).toContain('https://wbot.example/migrate-v2')
		expect(result.stderr.match(/Platform API deprecation/g)).toHaveLength(1)

		const warnings: Array<string> = []
		const linkOnlyClient = createPlatformClient({
			baseUrl: 'https://platform.example.test',
			tenantApiKey: 'fixture-secret',
			onDeprecationWarning: (warning) => warnings.push(warning),
			fetch: async () =>
				new Response(JSON.stringify({ items: [createConversationFixture()] }), {
					status: 200,
					headers: { Link: '<https://platform.example/docs>; rel="help"' },
				}),
		})
		await linkOnlyClient.listConversations()
		expect(warnings).toEqual([])
	})

	test('场景 5.2：MCP 弃用警告不破坏协议', async () => {
		const platformUrl = await createPlatformServer(
			{ items: [createConversationFixture()] },
			{
				Deprecation: '@1788739200',
				Sunset: 'Tue, 08 Dec 2026 00:00:00 GMT',
			},
		)
		const mcp = await createStdioMcpFixture({ WBOT_PLATFORM_URL: platformUrl })

		const result = await mcp.client.callTool({
			name: 'list_conversations',
			arguments: {},
		})

		expect(result.isError, JSON.stringify(result)).not.toBe(true)
		expect(result.structuredContent).toMatchObject({
			result: { items: [{ id: 'conversation-1' }] },
		})
		await mcp.close()
	})

	test('场景 5.3：自托管 origin 不获得 Celados 在线期限承诺', async () => {
		const policy = await readFile(
			join(repositoryRoot, 'docs/releasing.md'),
			'utf8',
		)

		expect(policy).toContain(
			'wire contract applies to any conformant Platform implementation',
		)
		expect(policy).toContain(
			'self-hosted operators own their deployment upgrades',
		)
		expect(policy).toContain('at least 90 days')
	})
})

describe('功能 6：稳定发布具有当前后端兼容证据', () => {
	test('场景 6.1：候选客户端通过当前 test Platform 后才能稳定发布', async () => {
		const workflow = await readFile(
			join(repositoryRoot, '.github/workflows/release.yml'),
			'utf8',
		)

		expect(workflow).toContain(
			'Verify candidate artifact against current test Platform',
		)
		expect(workflow).toContain("steps.preflight.outputs.prerelease == 'false'")
		expect(workflow).toContain('WBOT_API_KEY: ${{ secrets.WBOT_TEST_API_KEY }}')
		expect(workflow).toMatch(
			/verify-platform-compatibility\.ts\s+--artifact "\$RELEASE_DIR\/wbot-\$VERSION\.tgz"/,
		)

		const fixture = await createFixture()
		const releaseDirectory = await createTemporaryDirectory()
		const build = await runBunScript(
			[
				join(packageRoot, 'scripts/verify-package-artifact.ts'),
				'--output-dir',
				releaseDirectory,
			],
			{},
		)
		const platform = await createCompatibilityPlatformServer()
		const compatibility = await runBunScript(
			[
				join(packageRoot, 'scripts/verify-platform-compatibility.ts'),
				'--artifact',
				join(releaseDirectory, `wbot-${fixture.expectedVersion}.tgz`),
			],
			{
				WBOT_PLATFORM_URL: platform.url,
				WBOT_API_KEY: 'fixture-secret',
			},
		)

		expect(build.exitCode, build.stderr).toBe(0)
		expect(compatibility.exitCode, compatibility.stderr).toBe(0)
		expect(compatibility.stdout).toContain(
			'against the current test Platform contract',
		)
		expect(platform.paths).toEqual([
			'GET /platform/v2/webhooks',
			'GET /platform/v2/accounts',
			'GET /platform/v2/conversations',
			'GET /platform/v2/conversations/conversation-1/messages?limit=1',
			'GET /platform/v2/conversations/conversation-1/messages/message-1',
			'GET /platform/v2/conversations/conversation-1/changes?limit=50',
			'GET /platform/v2/conversations/conversation-1/changes?cursor=tail-cursor&limit=1',
		])
	}, 30_000)

	test('场景 6.2：只完成打包不能证明版本稳定', async () => {
		const workflow = await readFile(
			join(repositoryRoot, '.github/workflows/release.yml'),
			'utf8',
		)
		const compatibilityGate = workflow.indexOf(
			'Verify candidate artifact against current test Platform',
		)
		const tagCreation = workflow.indexOf('Create immutable release tag')
		const script = await runBunScript(
			[
				join(packageRoot, 'scripts/verify-platform-compatibility.ts'),
				'--artifact',
				join(packageRoot, 'missing.tgz'),
			],
			{},
		)

		expect(compatibilityGate).toBeGreaterThan(-1)
		expect(tagCreation).toBeGreaterThan(compatibilityGate)
		expect(script.exitCode).not.toBe(0)
		expect(script.stderr).toContain(
			'Stable release compatibility gate requires',
		)
	})
})

describe('功能 2：版本号表达公开契约影响', () => {
	test('场景 2.1：兼容变化使用 patch 版本', () => {
		expect(() =>
			requireVersionIncrement('0.1.2', '0.1.3', 'compatible'),
		).not.toThrow()
		expect(() =>
			requireVersionIncrement('0.1.2', '0.2.0', 'compatible'),
		).toThrow('Compatible change must increment patch')
	})

	test('场景 2.2：破坏性变化使用 minor 版本并先发布 RC', () => {
		expect(() =>
			requireVersionIncrement('0.1.2', '0.2.0-rc.1', 'breaking'),
		).not.toThrow()
		expect(() =>
			requireVersionIncrement('0.2.0-rc.1', '0.2.0-rc.2', 'breaking'),
		).not.toThrow()
		expect(() =>
			requireVersionIncrement('0.2.0-rc.2', '0.2.0', 'breaking'),
		).not.toThrow()
		expect(() => requireVersionIncrement('0.1.2', '0.1.3', 'breaking')).toThrow(
			'Breaking pre-1.0 change must increment minor and start with rc.1',
		)
		expect(() => requireVersionIncrement('0.1.2', '0.2.0', 'breaking')).toThrow(
			'Breaking pre-1.0 change must increment minor and start with rc.1',
		)
	})

	test('场景 2.3：公开结果增加必填属性属于破坏性变化', () => {
		expect(
			readReleaseImpact(`### Breaking Changes

- Conversation results now require capture freshness.
`),
		).toBe('breaking')
		expect(
			readReleaseImpact(`### Added

- Conversation results may include an optional avatar.
      `),
		).toBe('compatible')
	})

	test.each([
		{
			change: '内部重构且外部行为不变',
			nextVersion: null,
			impact: 'compatible' as const,
			requiresApiMajor: false,
		},
		{
			change: '修复既有行为',
			nextVersion: '0.1.3',
			impact: 'compatible' as const,
			requiresApiMajor: false,
		},
		{
			change: '增加旧客户端可忽略的可选响应字段',
			nextVersion: '0.1.3',
			impact: 'compatible' as const,
			requiresApiMajor: false,
		},
		{
			change: '增加公开结果的必填 TypeScript 属性',
			nextVersion: '0.2.0-rc.1',
			impact: 'breaking' as const,
			requiresApiMajor: false,
		},
		{
			change: '删除或改变活跃 API Major 的既有 wire 语义',
			nextVersion: '0.2.0-rc.1',
			impact: 'breaking' as const,
			requiresApiMajor: true,
		},
	])('版本分类真值表：$change', (row) => {
		if (row.nextVersion === null) {
			expect(row.nextVersion).toBeNull()
			return
		}
		expect(() =>
			requireVersionIncrement('0.1.2', row.nextVersion, row.impact),
		).not.toThrow()
		expect(row.requiresApiMajor).toBe(row.change.includes('wire 语义'))
	})
})

const runCli = async (
	arguments_: Array<string>,
	environment: Record<string, string> = {},
) => {
	const child = spawn('bun', ['run', cliEntry, ...arguments_], {
		env: { PATH: requiredProcessEnv('PATH'), ...environment },
	})
	let stdout = ''
	let stderr = ''
	child.stdout.setEncoding('utf8')
	child.stderr.setEncoding('utf8')
	child.stdout.on('data', (chunk: string) => {
		stdout += chunk
	})
	child.stderr.on('data', (chunk: string) => {
		stderr += chunk
	})
	const [exitCode] = (await once(child, 'close')) as [number]
	return { stdout, stderr, exitCode }
}

const runBunScript = async (
	arguments_: Array<string>,
	environment: Record<string, string>,
) => {
	const child = spawn('bun', ['run', ...arguments_], {
		env: {
			PATH: requiredProcessEnv('PATH'),
			HOME: requiredProcessEnv('HOME'),
			...environment,
		},
	})
	let stdout = ''
	let stderr = ''
	child.stdout.setEncoding('utf8')
	child.stderr.setEncoding('utf8')
	child.stdout.on('data', (chunk: string) => {
		stdout += chunk
	})
	child.stderr.on('data', (chunk: string) => {
		stderr += chunk
	})
	const [exitCode] = (await once(child, 'close')) as [number]
	return { stdout, stderr, exitCode }
}

const createStdioMcpFixture = async (
	environment: Record<string, string> = {},
) => {
	const client = new Client({
		name: 'wbot-release-policy-test',
		version: '1.0.0',
	})
	const transport = new StdioClientTransport({
		command: 'bun',
		args: ['run', cliEntry, 'mcp'],
		env: {
			PATH: requiredProcessEnv('PATH'),
			WBOT_API_KEY: 'fixture-secret',
			...environment,
		},
		stderr: 'pipe',
	})
	await client.connect(transport)
	return {
		client,
		close: () => client.close(),
	}
}

const readJson = async (path: string) =>
	JSON.parse(await readFile(path, 'utf8'))

const readPinnedVersion = (manifest: {
	mcpServers: { wbot: { args: Array<string> } }
}) => {
	const packageArgument = manifest.mcpServers.wbot.args.find((argument) =>
		argument.startsWith('@celados/wbot@'),
	)
	const match = packageArgument?.match(/\/download\/v([^/]+)\/wbot-[^/]+\.tgz$/)
	if (!match?.[1])
		throw new Error('Plugin runtime URL must pin a versioned wbot artifact.')
	return match[1]
}

const requiredProcessEnv = (name: string) => {
	const value = process.env[name]
	if (value === undefined) throw new Error(`${name} is required for tests`)
	return value
}

const createPlatformServer = (
	body: unknown,
	headers: Readonly<Record<string, string>> = {},
) =>
	new Promise<string>((resolve, reject) => {
		const server = createServer((_request, response) => {
			response.statusCode = 200
			response.setHeader('Content-Type', 'application/json')
			for (const [name, value] of Object.entries(headers))
				response.setHeader(name, value)
			response.end(JSON.stringify(body))
		})
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => {
			const address = server.address()
			if (address === null || typeof address === 'string') {
				reject(new Error('Test server did not expose a TCP address.'))
				return
			}
			servers.push(server)
			resolve(`http://127.0.0.1:${address.port}`)
		})
	})

const listen = (server: Server) =>
	new Promise<string>((resolve, reject) => {
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => {
			const address = server.address()
			if (address === null || typeof address === 'string') {
				reject(new Error('Test server did not expose a TCP address.'))
				return
			}
			servers.push(server)
			resolve(`http://127.0.0.1:${address.port}`)
		})
	})

/** Serves v2 list, timeline, and change-log bodies by path suffix. */
const createRoutedPlatformServer = (bodies: {
	conversations: unknown
	messages: unknown
	changes: unknown
}) =>
	listen(
		createServer((request, response) => {
			const path = new URL(request.url ?? '/', 'http://fixture').pathname
			response.setHeader('Content-Type', 'application/json')
			response.end(
				JSON.stringify(
					path.endsWith('/changes')
						? bodies.changes
						: path.endsWith('/messages')
							? bodies.messages
							: bodies.conversations,
				),
			)
		}),
	)

const createCompatibilityPlatformServer = async () => {
	const paths: Array<string> = []
	const url = await listen(
		createServer((request, response) => {
			const path = request.url ?? ''
			paths.push(`${request.method} ${path}`)
			response.statusCode = 200
			response.setHeader('Content-Type', 'application/json')
			const pathname = new URL(path, 'http://fixture').pathname
			const body =
				pathname === '/platform/v2/webhooks'
					? { items: [] }
					: pathname === '/platform/v2/accounts'
						? { items: [createAccountFixture()] }
						: pathname === '/platform/v2/conversations'
							? { items: [createConversationFixture()] }
							: pathname.endsWith('/messages')
								? {
										items: [createMessageFixture()],
										nextCursor: 'history-next',
										hasMore: true,
									}
								: pathname.endsWith('/messages/message-1')
									? createMessageFixture()
									: { items: [], nextCursor: 'tail-cursor', hasMore: false }
			response.end(JSON.stringify(body))
		}),
	)
	return { url, paths }
}

const createTemporaryDirectory = async () => {
	const path = await mkdtemp(join(tmpdir(), 'wbot-release-policy-test-'))
	temporaryDirectories.push(path)
	return path
}
