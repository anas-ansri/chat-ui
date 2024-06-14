import {
	ToolResultStatus,
	type ToolCall,
	type ToolFunction,
	type ToolResult,
} from "$lib/types/Tool";
import { v4 as uuidV4 } from "uuid";
import JSON5 from "json5";
import { toolFromConfigs, type BackendToolContext } from "../tools";
import {
	MessageToolUpdateType,
	MessageUpdateStatus,
	MessageUpdateType,
	type MessageUpdate,
} from "$lib/types/MessageUpdate";
import type { TextGenerationContext } from "./types";

import directlyAnswer from "../tools/directlyAnswer";
import websearch from "../tools/web/search";
import { z } from "zod";
import { logger } from "../logger";
import { toolHasName } from "../tools/utils";
import type { MessageFile } from "$lib/types/Message";
import { mergeAsyncGenerators } from "$lib/utils/mergeAsyncGenerators";
import { MetricsServer } from "../metrics";
import { stringifyError } from "$lib/utils/stringifyError";

function makeFilesPrompt(files: MessageFile[], fileMessageIndex: number): string {
	if (files.length === 0) {
		return "The user has not uploaded any files. Do not attempt to use any tools that require files";
	}

	const stringifiedFiles = files
		.map(
			(file, fileIndex) =>
				`  - fileMessageIndex ${fileMessageIndex} | fileIndex ${fileIndex} | ${file.name} (${file.mime})`
		)
		.join("\n");
	return `Attached ${files.length} file${files.length === 1 ? "" : "s"}:\n${stringifiedFiles}`;
}

export function filterToolsOnPreferences(
	toolsPreference: Record<string, boolean>,
	isAssistant: boolean
): ToolFunction[] {
	// if it's an assistant, only support websearch for now
	if (isAssistant) return [...directlyAnswer.functions, ...websearch.functions];

	logger.info({ toolsPreference });
	// filter based on tool preferences, add the tools that are on by default
	return toolFromConfigs
		.filter((el) => {
			if (el.isLocked && el.isOnByDefault) return true;
			return toolsPreference?.[el._id.toString()] ?? el.isOnByDefault;
		})
		.map((el) => el.functions)
		.flat();
}

async function* callTool(
	ctx: BackendToolContext,
	tools: ToolFunction[],
	call: ToolCall
): AsyncGenerator<MessageUpdate, ToolResult | undefined, undefined> {
	const uuid = uuidV4();

	const tool = tools.find((el) => toolHasName(call.name, el));
	if (!tool) {
		return { call, status: ToolResultStatus.Error, message: `Could not find tool "${call.name}"` };
	}

	// Special case for directly_answer tool where we ignore
	if (toolHasName(directlyAnswer.functions[0].name, tool)) return;

	const startTime = Date.now();
	MetricsServer.getMetrics().tool.toolUseCount.inc({ tool: call.name });

	yield {
		type: MessageUpdateType.Tool,
		subtype: MessageToolUpdateType.Call,
		uuid,
		call,
	};

	try {
		const toolResult = yield* tool.call(call.parameters, ctx);

		yield {
			type: MessageUpdateType.Tool,
			subtype: MessageToolUpdateType.Result,
			uuid,
			result: { ...toolResult, call } as ToolResult,
		};

		MetricsServer.getMetrics().tool.toolUseDuration.observe(
			{ tool: call.name },
			Date.now() - startTime
		);

		return { ...toolResult, call } as ToolResult;
	} catch (error) {
		MetricsServer.getMetrics().tool.toolUseCountError.inc({ tool: call.name });
		logger.error(error, `Failed while running tool ${call.name}. ${stringifyError(error)}`);

		yield {
			type: MessageUpdateType.Tool,
			subtype: MessageToolUpdateType.Error,
			uuid,
			message: "Error occurred",
		};

		return {
			call,
			status: ToolResultStatus.Error,
			message: "Error occurred",
		};
	}
}

export async function* runTools(
	ctx: TextGenerationContext,
	tools: ToolFunction[],
	preprompt?: string
): AsyncGenerator<MessageUpdate, ToolResult[], undefined> {
	const { endpoint, conv, messages, assistant, ip, username } = ctx;
	const calls: ToolCall[] = [];

	const messagesWithFilesPrompt = messages.map((message, idx) => {
		if (!message.files?.length) return message;
		return {
			...message,
			content: `${message.content}\n${makeFilesPrompt(message.files, idx)}`,
		};
	});

	const pickToolStartTime = Date.now();

	// do the function calling bits here
	for await (const output of await endpoint({
		messages: messagesWithFilesPrompt,
		preprompt,
		generateSettings: assistant?.generateSettings,
		tools,
	})) {
		// model natively supports tool calls
		if (output.token.toolCalls) {
			calls.push(...output.token.toolCalls);
			continue;
		}

		// look for a code blocks of ```json and parse them
		// if they're valid json, add them to the calls array
		if (output.generated_text) {
			const codeBlocks = Array.from(output.generated_text.matchAll(/```json\n(.*?)```/gs))
				.map(([, block]) => block)
				// remove trailing comma
				.map((block) => block.trim().replace(/,$/, ""));
			if (codeBlocks.length === 0) continue;

			// grab only the capture group from the regex match
			for (const block of codeBlocks) {
				try {
					calls.push(
						...JSON5.parse(block)
							.filter(isExternalToolCall)
							.map((toolCall: ExternalToolCall) => externalToToolCall(toolCall, tools))
							.filter(Boolean)
					);
				} catch (e) {
					logger.error(e, "Failed to parse tool call");
					// error parsing the calls
					yield {
						type: MessageUpdateType.Status,
						status: MessageUpdateStatus.Error,
						message: "Error while parsing tool calls, please retry",
					};
				}
			}
		}
	}

	MetricsServer.getMetrics().tool.timeToChooseTools.observe(
		{ model: conv.model },
		Date.now() - pickToolStartTime
	);

	const toolContext: BackendToolContext = { conv, messages, preprompt, assistant, ip, username };
	const toolResults: (ToolResult | undefined)[] = yield* mergeAsyncGenerators(
		calls.map((call) => callTool(toolContext, tools, call))
	);
	return toolResults.filter((result): result is ToolResult => result !== undefined);
}

const externalToolCall = z.object({
	tool_name: z.string(),
	parameters: z.record(z.any()),
});

type ExternalToolCall = z.infer<typeof externalToolCall>;

function isExternalToolCall(call: unknown): call is ExternalToolCall {
	return externalToolCall.safeParse(call).success;
}

function externalToToolCall(
	call: ExternalToolCall,
	toolFunctions: ToolFunction[]
): ToolCall | undefined {
	// Convert - to _ since some models insist on using _ instead of -
	const tool = toolFunctions.find((tool) => toolHasName(call.tool_name, tool));
	if (!tool) {
		logger.debug(`Model requested tool that does not exist: "${call.tool_name}". Skipping tool...`);
		return;
	}

	const parametersWithDefaults: Record<string, string> = {};

	for (const input of tool.inputs) {
		const value = call.parameters[input.name];

		// Required so ensure it's there, otherwise return undefined
		if (input.required) {
			if (value === undefined) {
				logger.debug(
					`Model requested tool "${call.tool_name}" but was missing required parameter "${input.name}". Skipping tool...`
				);
				return;
			}
			parametersWithDefaults[input.name] = value;
			continue;
		}

		// Optional so use default if not there
		parametersWithDefaults[input.name] = value ?? input.default;
	}

	return {
		name: call.tool_name,
		parameters: parametersWithDefaults,
	};
}
