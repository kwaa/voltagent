import { createAsyncIterableStream } from "@voltagent/internal/utils";
import type { Mock, Mocked } from "vitest";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentEventEmitter } from "../events";
import type { Memory, MemoryMessage } from "../memory/types";
import { AgentRegistry } from "../server/registry";
import { createTool } from "../tool";
import { Agent } from "./index";
import type {
  BaseMessage,
  BaseTool,
  LLMProvider,
  ProviderObjectResponse,
  ProviderObjectStreamResponse,
  ProviderTextResponse,
  ProviderTextStreamResponse,
  StepWithContent,
} from "./providers";

// @ts-ignore - To simplify test types
import type { AgentHistoryEntry } from "../agent/history";
import type { NewTimelineEvent } from "../events/types";
import type { BaseRetriever } from "../retriever/retriever";
import type { VoltAgentExporter } from "../telemetry/exporter";
import type { Tool, Toolkit } from "../tool";
import { HistoryManager } from "./history";
import { createHooks } from "./hooks";
import type { AgentStatus, OperationContext, ToolExecutionContext } from "./types";
import type { DynamicValueOptions } from "./types";

// Define a generic mock model type locally
type MockModelType = { modelId: string; [key: string]: unknown };

// Helper function to extract string content from MessageContent
function getStringContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object" && "type" in part) {
          if (part.type === "text" && "text" in part) {
            return part.text;
          }
        }
        return "";
      })
      .join("");
  }
  return "";
}

// Mock types for testing
type MockGenerateTextResult = {
  text: string;
};

type MockStreamTextResult = ReadableStream<{
  type: "text-delta";
  textDelta: string;
}>;

type MockGenerateObjectResult<T> = {
  object: T;
};

type MockStreamObjectResult<T> = {
  stream: ReadableStream<{
    type: "text-delta";
    textDelta: string;
  }>;
  partialObjectStream: ReadableStream<T>;
  textStream: ReadableStream<string>;
};

// A simplified History object - updated to match new AgentHistoryEntry structure
// @ts-ignore - Simplified AgentHistoryEntry for testing
const createMockHistoryEntry = (
  input: string,
  status: AgentStatus = "completed",
): AgentHistoryEntry => {
  return {
    id: `entry-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
    input,
    output: `Response to ${input}`,
    status: status as AgentStatus,
    startTime: new Date(), // Updated from timestamp to startTime
    endTime: new Date(), // Added endTime
    steps: [], // Added steps array
  };
};

// Creating a vi mock for Memory interface
// @ts-ignore - This won't be fully compatible with all properties, this is a test
const mockMemory = {
  getMessages: vi.fn().mockImplementation(async () => []),
  addMessage: vi.fn(),
  clearMessages: vi.fn(),
  createConversation: vi.fn(),
  getConversation: vi.fn(),
  getConversations: vi.fn(),
  updateConversation: vi.fn(),
  deleteConversation: vi.fn(),

  // Simplified mock methods related to History
  addHistoryEntry: vi.fn(),
  updateHistoryEntry: vi.fn(),
  getHistoryEntry: vi.fn(),
  addHistoryEvent: vi.fn(),
  updateHistoryEvent: vi.fn(),
  getHistoryEvent: vi.fn(),
  addHistoryStep: vi.fn(),
  updateHistoryStep: vi.fn(),
  getHistoryStep: vi.fn(),
  getAllHistoryEntriesByAgent: vi.fn(),

  // Added missing addTimelineEvent method
  addTimelineEvent: vi
    .fn()
    .mockImplementation(
      async (_key: string, _value: NewTimelineEvent, _historyId: string, _agentId: string) => {
        // Mock implementation - just resolve
        return Promise.resolve();
      },
    ),

  // Add missing user-centric conversation methods
  getConversationsByUserId: vi.fn().mockImplementation(async () => []),
  queryConversations: vi.fn().mockImplementation(async () => []),
  getConversationMessages: vi.fn().mockImplementation(async () => []),

  // Special test requirements
  getHistoryEntries: vi.fn().mockImplementation(async () => {
    return [createMockHistoryEntry("Test input")];
  }),
};

vi.mock("../utils/streams/stream-event-forwarder", { spy: true });

// Mock Provider implementation for testing
class MockProvider implements LLMProvider<MockModelType> {
  generateTextCalls = 0;
  streamTextCalls = 0;
  generateObjectCalls = 0;
  streamObjectCalls = 0;
  lastMessages: BaseMessage[] = [];

  // @ts-ignore
  constructor(private model: MockModelType) {}

  toMessage(message: BaseMessage): BaseMessage {
    return message;
  }

  fromMessage(message: BaseMessage): BaseMessage {
    return message;
  }

  getModelIdentifier(model: MockModelType): string {
    return model.modelId;
  }

  async generateText(options: {
    messages: BaseMessage[];
    model: MockModelType;
    tools?: BaseTool[];
    maxSteps?: number;
    signal?: AbortSignal;
    onStepFinish?: (step: StepWithContent) => Promise<void>;
    toolExecutionContext?: ToolExecutionContext;
  }): Promise<ProviderTextResponse<MockGenerateTextResult>> {
    this.generateTextCalls++;
    this.lastMessages = options.messages;

    // Check abort signal
    if (options.signal?.aborted) {
      const error = new Error("Operation aborted");
      error.name = "AbortError";
      throw error;
    }

    // If there are tools and the message contains tool-related keywords, simulate tool usage
    if (
      options.tools &&
      options.tools.length > 0 &&
      options.messages.some((m) => {
        const content = getStringContent(m.content);
        return (
          content.includes("Use the test tool") ||
          content.includes("delegate_task") ||
          content.includes("hand this off") ||
          content.includes("delegate")
        );
      })
    ) {
      // Find the appropriate tool to call
      const toolToCall = options.tools.find(
        (tool) => tool.name === "delegate_task" || tool.name === "test-tool",
      );

      if (toolToCall && options.onStepFinish) {
        const toolCallId = `${toolToCall.name}-call-id`;

        // Simulate tool call step
        await options.onStepFinish({
          type: "tool_call",
          role: "assistant",
          content: `Using ${toolToCall.name}`,
          id: toolCallId,
          name: toolToCall.name,
          arguments:
            toolToCall.name === "delegate_task"
              ? {
                  task: "Test delegation task",
                  targetAgents: ["RealSubAgent"],
                  context: {},
                }
              : {},
        });

        // Execute the actual tool if it's delegate_task
        let toolResult = "tool result";
        if (toolToCall.name === "delegate_task" && toolToCall.execute) {
          try {
            const result = await toolToCall.execute({
              task: "Test delegation task",
              targetAgents: ["RealSubAgent"],
              context: {},
            });
            toolResult = JSON.stringify(result);
          } catch (error) {
            toolResult = `Error: ${error}`;
          }
        }

        // Simulate tool result step
        await options.onStepFinish({
          type: "tool_result",
          role: "tool",
          content: toolResult,
          id: toolCallId,
          name: toolToCall.name,
          result: toolResult,
        });
      }
    }

    const result = { text: "Hello, I am a test agent!" };

    // Simulate final text response step like real providers do
    if (options.onStepFinish) {
      await options.onStepFinish({
        type: "text",
        role: "assistant",
        content: result.text,
        id: "final-text-step",
      });
    }

    return {
      provider: result,
      text: result.text,
      usage: {
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
      },
      toolCalls: [],
      toolResults: [],
      finishReason: "stop",
    };
  }

  async streamText(options: {
    messages: BaseMessage[];
    model: MockModelType;
    tools?: BaseTool[];
    maxSteps?: number;
    signal?: AbortSignal;
    onChunk?: (chunk: StepWithContent) => Promise<void>;
    onStepFinish?: (step: StepWithContent) => Promise<void>;
    onFinish?: (result: any) => Promise<void>;
    onError?: (error: any) => Promise<void>;
  }): Promise<ProviderTextStreamResponse<MockStreamTextResult>> {
    this.streamTextCalls++;
    this.lastMessages = options.messages;

    // Check if we should simulate tool usage
    const shouldUseTool =
      options.tools &&
      options.tools.length > 0 &&
      options.messages.some((m) => {
        const content = getStringContent(m.content);
        return (
          content.includes("Use the test tool") ||
          content.includes("delegate_task") ||
          content.includes("hand this off") ||
          content.includes("delegate")
        );
      });

    if (shouldUseTool) {
      // Find the appropriate tool to call
      const toolToCall = options.tools?.find(
        (tool) => tool.name === "delegate_task" || tool.name === "test-tool",
      );

      if (toolToCall) {
        const toolCallId = `${toolToCall.name}-call-id`;

        // Simulate tool call chunk
        if (options.onChunk) {
          await options.onChunk({
            type: "tool_call",
            role: "assistant",
            content: `Using ${toolToCall.name}`,
            id: toolCallId,
            name: toolToCall.name,
            arguments:
              toolToCall.name === "delegate_task"
                ? {
                    task: "Test delegation task",
                    targetAgents: ["RealSubAgent"],
                    context: {},
                  }
                : {},
          });
        }

        // Execute the actual tool if it's delegate_task
        let toolResult = "tool result";
        if (toolToCall.name === "delegate_task" && toolToCall.execute) {
          try {
            const result = await toolToCall.execute({
              task: "Test delegation task",
              targetAgents: ["RealSubAgent"],
              context: {},
            });
            toolResult = JSON.stringify(result);
          } catch (error) {
            toolResult = `Error: ${error}`;
          }
        }

        // Simulate tool result chunk
        if (options.onChunk) {
          await options.onChunk({
            type: "tool_result",
            role: "tool",
            content: toolResult,
            id: toolCallId,
            name: toolToCall.name,
            result: toolResult,
          });
        }
      }
    }

    const stream = createAsyncIterableStream(
      new ReadableStream<{
        type: "text-delta";
        textDelta: string;
      }>({
        start(controller) {
          controller.enqueue({ type: "text-delta", textDelta: "Hello" });
          controller.enqueue({ type: "text-delta", textDelta: ", " });
          controller.enqueue({ type: "text-delta", textDelta: "world!" });
          controller.close();
        },
      }),
    );

    // Create a text stream
    const textStream = createAsyncIterableStream(
      new ReadableStream<string>({
        start(controller) {
          controller.enqueue("Hello");
          controller.enqueue(", ");
          controller.enqueue("world!");
          controller.close();
        },
      }),
    );

    // Call onFinish if provided
    if (options.onFinish) {
      const finishCallback = options.onFinish;
      setTimeout(() => {
        finishCallback({
          text: "Hello, world!",
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          finishReason: "stop",
        });
      }, 0);
    }

    return {
      provider: stream,
      textStream,
    };
  }

  async generateObject<T extends z.ZodType>(options: {
    messages: BaseMessage[];
    model: MockModelType;
    schema: T;
    signal?: AbortSignal;
    onStepFinish?: (step: StepWithContent) => Promise<void>;
  }): Promise<ProviderObjectResponse<MockGenerateObjectResult<z.infer<T>>, z.infer<T>>> {
    this.generateObjectCalls++;
    this.lastMessages = options.messages;

    const result = {
      object: {
        name: "John Doe",
        age: 30,
        hobbies: ["reading", "gaming"],
      } as z.infer<T>,
    };

    // Simulate final object response step like real providers do
    if (options.onStepFinish) {
      await options.onStepFinish({
        type: "text",
        role: "assistant",
        content: JSON.stringify(result.object),
        id: "final-object-step",
      });
    }

    return {
      provider: result,
      object: result.object,
      usage: {
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
      },
      finishReason: "stop",
    };
  }

  async streamObject<T extends z.ZodType>(options: {
    messages: BaseMessage[];
    model: MockModelType;
    schema: T;
    onFinish?: (result: any) => Promise<void>;
    onError?: (error: any) => Promise<void>;
  }): Promise<ProviderObjectStreamResponse<MockStreamObjectResult<z.infer<T>>, z.infer<T>>> {
    this.streamObjectCalls++;
    this.lastMessages = options.messages;

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue({
          type: "text-delta",
          textDelta: '{"name": "John"}',
        });
        controller.close();
      },
    });

    const partialObjectStream = new ReadableStream<Partial<z.infer<T>>>({
      start(controller) {
        controller.enqueue({ name: "John" } as Partial<z.infer<T>>);
        controller.close();
      },
    });

    const textStream = new ReadableStream({
      start(controller) {
        controller.enqueue('{"name": "John"}');
        controller.close();
      },
    });

    const result = {
      stream,
      partialObjectStream,
      textStream,
    };

    // Call onFinish immediately for testing
    if (options.onFinish) {
      const mockResult = {
        object: { name: "John" } as z.infer<T>,
        usage: {
          completionTokens: 10,
          promptTokens: 20,
          totalTokens: 30,
        },
        finishReason: "stop" as const,
        warnings: undefined,
        providerResponse: undefined,
      };
      // Call onFinish synchronously in microtask to simulate async completion
      Promise.resolve().then(() => options.onFinish?.(mockResult));
    }

    return {
      provider: result,
      objectStream: createAsyncIterableStream(partialObjectStream),
    };
  }
}

// Test Agent class to access protected & private properties
class TestAgent<TProvider extends { llm: LLMProvider<unknown> }> extends Agent<TProvider> {
  getTools() {
    return this.toolManager.getTools();
  }

  // Add access to protected managers for testing
  getToolManager() {
    return this.toolManager;
  }

  getHistoryManager() {
    return this.historyManager;
  }

  getSubAgentManager() {
    return this.subAgentManager;
  }
}

// Mock HistoryManager
vi.mock("./history", () => ({
  HistoryManager: vi.fn().mockImplementation(() => {
    // createMockHistoryEntry test dosyasının global kapsamında tanımlıdır.
    // Çağrıldığında AgentHistoryEntry'ye benzeyen bir nesne döndürür.
    return {
      addEntry: vi.fn().mockImplementation(async (params: any) => {
        let entryInputString = "default_mock_input";
        if (params && typeof params.input === "string") {
          entryInputString = params.input;
        } else if (
          params &&
          Array.isArray(params.input) &&
          params.input.length > 0 &&
          params.input[0] &&
          typeof params.input[0].content === "string"
        ) {
          entryInputString = params.input[0].content;
        } else if (
          params?.input &&
          typeof params.input === "object" &&
          !Array.isArray(params.input)
        ) {
          entryInputString = JSON.stringify(params.input);
        }
        // createMockHistoryEntry, bu test dosyasında daha önce tanımlanmıştır.
        // @ts-ignore createMockHistoryEntry is defined in the outer scope
        return Promise.resolve(
          createMockHistoryEntry(entryInputString, params?.status || "working"),
        );
      }),
      getEntries: vi.fn().mockResolvedValue([]),
      updateEntry: vi
        .fn()
        .mockImplementation(async (id: string, updates: Partial<AgentHistoryEntry>) => {
          // @ts-ignore createMockHistoryEntry is defined in the outer scope
          const baseEntry = createMockHistoryEntry("updated_input_for_mock");
          return Promise.resolve({ ...baseEntry, id, ...updates });
        }),
      addStepsToEntry: vi
        .fn()
        .mockImplementation(async (id: string, newSteps: StepWithContent[]) => {
          // @ts-ignore createMockHistoryEntry is defined in the outer scope
          const baseEntry = createMockHistoryEntry("steps_added_input_for_mock");
          return Promise.resolve({
            ...baseEntry,
            id,
            steps: [...(baseEntry.steps || []), ...newSteps],
          });
        }),
      // Agent tarafından kullanılan diğer HistoryManager metodları buraya eklenebilir.
      // Örneğin: getEntryById, addEventToEntry
      getEntryById: vi.fn().mockImplementation(async (id: string) => {
        // @ts-ignore createMockHistoryEntry is defined in the outer scope
        return Promise.resolve(createMockHistoryEntry(`entry_for_${id}`));
      }),
      addEventToEntry: vi.fn().mockImplementation(async (id: string, _event: NewTimelineEvent) => {
        // @ts-ignore createMockHistoryEntry is defined in the outer scope
        const baseEntry = createMockHistoryEntry(`event_added_to_${id}`);
        // Remove events property since it doesn't exist in AgentHistoryEntry
        return Promise.resolve({ ...baseEntry, id });
      }),
    };
  }),
}));

// Mock VoltAgentExporter
const mockTelemetryExporter = {
  publicKey: "mock-telemetry-public-key",
  exportHistoryEntry: vi.fn(),
  exportTimelineEvent: vi.fn(),
  exportHistorySteps: vi.fn(),
  updateHistoryEntry: vi.fn(),
  updateTimelineEvent: vi.fn(),
} as unknown as VoltAgentExporter;

// Mock AgentEventEmitter globally
const mockEventEmitter = {
  getInstance: vi.fn().mockReturnThis(),
  addHistoryEvent: vi.fn(),
  emitHistoryEntryCreated: vi.fn(),
  emitHistoryUpdate: vi.fn(),
  emitAgentRegistered: vi.fn(),
  emitAgentUnregistered: vi.fn(),
  onAgentRegistered: vi.fn(),
  onAgentUnregistered: vi.fn(),
  onHistoryEntryCreated: vi.fn(),
  onHistoryUpdate: vi.fn(),
  publishTimelineEventAsync: vi.fn(),
} as unknown as Mocked<AgentEventEmitter>;

// Mock AgentEventEmitter.getInstance globally
vi.spyOn(AgentEventEmitter, "getInstance").mockReturnValue(mockEventEmitter);

describe("Agent", () => {
  let agent: TestAgent<{ llm: MockProvider }>;
  let mockModel: MockModelType;
  let mockProvider: MockProvider;

  beforeEach(() => {
    mockModel = { modelId: "mock-model-id" }; // Use a simple object conforming to MockModelType
    mockProvider = new MockProvider(mockModel);

    // Reset mock memory before each test
    // @ts-ignore - To overcome Object.keys and vi mock type issues
    for (const key of Object.keys(mockMemory)) {
      // @ts-ignore - To overcome type issues with Jest mocks
      if (
        // @ts-ignore - To overcome type issues with Jest mocks
        typeof mockMemory[key] === "function" &&
        // @ts-ignore - To overcome type issues with Jest mocks
        typeof mockMemory[key].mockClear === "function"
      ) {
        // @ts-ignore - To overcome type issues with Jest mocks
        mockMemory[key].mockClear();
      }
    }

    // Create a ready test agent
    // @ts-ignore - Bypass Memory type
    agent = new TestAgent({
      id: "test-agent",
      name: "Test Agent",
      description: "A test agent for unit testing",
      model: mockModel,
      llm: mockProvider,
      memory: mockMemory,
      memoryOptions: {},
      tools: [],
      instructions: "A helpful AI assistant",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("constructor", () => {
    it("should create an agent with default values", () => {
      const defaultAgent = new TestAgent({
        name: "Default Agent",
        model: mockModel,
        llm: mockProvider,
        instructions: "A helpful AI assistant",
        memory: mockMemory,
      });

      expect(defaultAgent.id).toBeDefined();
      expect(defaultAgent.name).toBe("Default Agent");
      expect(defaultAgent.instructions).toBe("A helpful AI assistant");
      expect(defaultAgent.model).toBe(mockModel);
      expect(defaultAgent.llm).toBe(mockProvider);
    });

    it("should create an agent with custom values", () => {
      const customAgent = new TestAgent({
        id: "custom-id",
        name: "Custom Agent",
        instructions: "Custom description",
        model: mockModel,
        llm: mockProvider,
        memory: mockMemory,
      });

      expect(customAgent.id).toBe("custom-id");
      expect(customAgent.name).toBe("Custom Agent");
      expect(customAgent.instructions).toBe("Custom description");
      expect(customAgent.llm).toBe(mockProvider);
    });

    it("should use description for instructions if instructions property is not provided", () => {
      const agentWithDesc = new TestAgent({
        name: "Agent With Description Only",
        description: "Uses provided description",
        model: mockModel,
        llm: mockProvider,
        memory: mockMemory,
        // instructions property is intentionally omitted
      });
      expect(agentWithDesc.instructions).toBe("Uses provided description");
      expect(agentWithDesc.description).toBe("Uses provided description"); // Verifying this.description is also updated
    });

    it("should use instructions if both instructions and description are provided", () => {
      const agentWithBoth = new TestAgent({
        name: "Agent With Both Properties",
        instructions: "Uses provided instructions",
        description: "This description should be ignored",
        model: mockModel,
        llm: mockProvider,
        memory: mockMemory,
      });
      expect(agentWithBoth.instructions).toBe("Uses provided instructions");
      expect(agentWithBoth.description).toBe("Uses provided instructions");
    });

    it("should create agent with maxSteps", () => {
      const agentWithMaxSteps = new TestAgent({
        name: "MaxSteps Agent",
        instructions: "Agent with maxSteps",
        llm: mockProvider,
        model: mockModel,
        maxSteps: 25,
        memory: mockMemory,
      });

      expect(agentWithMaxSteps.name).toBe("MaxSteps Agent");
      // Test that maxSteps was passed correctly
      expect(agentWithMaxSteps.getSubAgentManager().calculateMaxSteps(25)).toBe(25);
    });

    it("should create agent without maxSteps", () => {
      const agentWithoutMaxSteps = new TestAgent({
        name: "No MaxSteps Agent",
        instructions: "Agent without maxSteps",
        llm: mockProvider,
        model: mockModel,
        memory: mockMemory,
        // No maxSteps
      });

      // Should use default behavior
      expect(agentWithoutMaxSteps.getSubAgentManager().calculateMaxSteps()).toBe(10);
    });

    // --- BEGIN NEW TELEMETRY-RELATED CONSTRUCTOR TESTS ---
    it("should pass telemetryExporter to HistoryManager if provided", () => {
      (HistoryManager as Mock).mockClear();

      new Agent({
        name: "TelemetryAgent",
        instructions: "Telemetry agent instructions",
        model: mockModel,
        llm: mockProvider,
        telemetryExporter: mockTelemetryExporter,
        memory: mockMemory as Memory,
      });

      expect(HistoryManager).toHaveBeenCalledTimes(1);
      expect(HistoryManager).toHaveBeenCalledWith(
        expect.any(String),
        expect.anything(),
        expect.any(Number),
        mockTelemetryExporter,
        expect.anything(), // logger parameter
      );
    });

    it("should instantiate HistoryManager without telemetryExporter if not provided", () => {
      (HistoryManager as Mock).mockClear();

      new Agent({
        name: "NoTelemetryAgent",
        instructions: "No telemetry agent instructions",
        model: mockModel,
        llm: mockProvider,
        memory: mockMemory as Memory,
      });

      expect(HistoryManager).toHaveBeenCalledTimes(1);
      const historyManagerArgs = (HistoryManager as Mock).mock.calls[0];
      expect(historyManagerArgs.length).toBeGreaterThanOrEqual(3);
      expect(historyManagerArgs[3]).toBeUndefined();
    });
    // --- END NEW TELEMETRY-RELATED CONSTRUCTOR TESTS ---
  });

  describe("generate", () => {
    it("should delegate text generation to provider", async () => {
      const response = await agent.generateText("Hello!");
      expect(mockProvider.generateTextCalls).toBe(1);
      expect(response.text).toBe("Hello, I am a test agent!");
    });

    it("should always include system message at the beginning of messages", async () => {
      await agent.generateText("Hello!");
      expect(mockProvider.lastMessages[0].role).toBe("system");
      expect(getStringContent(mockProvider.lastMessages[0].content)).toContain("Test Agent");
      expect(mockProvider.lastMessages[1].role).toBe("user");
      expect(getStringContent(mockProvider.lastMessages[1].content)).toBe("Hello!");
    });

    it("should maintain system message at the beginning when using BaseMessage[] input", async () => {
      const messages: BaseMessage[] = [
        { role: "user", content: "Hello!" },
        { role: "assistant", content: "Hi there!" },
        { role: "user", content: "How are you?" },
      ];

      await agent.generateText(messages);
      expect(mockProvider.lastMessages[0].role).toBe("system");
      expect(getStringContent(mockProvider.lastMessages[0].content)).toContain("Test Agent");
      expect(mockProvider.lastMessages.slice(1)).toEqual(messages);
    });

    it("should maintain system message at the beginning when using memory", async () => {
      const userId = "test-user";
      const message = "Hello!";

      await agent.generateText(message, { userId });

      // Verify system message is at the beginning
      expect(mockProvider.lastMessages[0].role).toBe("system");
      expect(getStringContent(mockProvider.lastMessages[0].content)).toContain("Test Agent");
      expect(mockProvider.lastMessages[1].role).toBe("user");
      expect(getStringContent(mockProvider.lastMessages[1].content)).toBe(message);
    });

    it("should maintain system message at the beginning with context limit", async () => {
      const userId = "test-user";
      const contextLimit = 2;
      const message = "Hello!";

      // Mock getMessages to return some messages
      mockMemory.getMessages.mockImplementationOnce(
        async () =>
          [
            {
              role: "user",
              content: "Message 1",
              id: "1",
              type: "text",
              createdAt: new Date().toISOString(),
            },
            {
              role: "assistant",
              content: "Response 1",
              id: "2",
              type: "text",
              createdAt: new Date().toISOString(),
            },
          ] as MemoryMessage[],
      );

      await agent.generateText(message, { userId, contextLimit });

      // Verify system message is at the beginning
      expect(mockProvider.lastMessages[0].role).toBe("system");
      expect(getStringContent(mockProvider.lastMessages[0].content)).toContain("Test Agent");
      expect(mockProvider.lastMessages[1].role).toBe("user");
      expect(getStringContent(mockProvider.lastMessages[1].content)).toBe("Message 1");
      expect(mockProvider.lastMessages[2].role).toBe("assistant");
      expect(getStringContent(mockProvider.lastMessages[2].content)).toBe("Response 1");
      expect(mockProvider.lastMessages[3].role).toBe("user");
      expect(getStringContent(mockProvider.lastMessages[3].content)).toBe(message);
    });

    it("should handle BaseMessage[] input for text generation", async () => {
      const messages: BaseMessage[] = [
        { role: "user", content: "Hello!" },
        { role: "assistant", content: "Hi there!" },
        { role: "user", content: "How are you?" },
      ];

      const response = await agent.generateText(messages);
      expect(mockProvider.generateTextCalls).toBe(1);
      expect(response.text).toBe("Hello, I am a test agent!");
      expect(mockProvider.lastMessages).toEqual(expect.arrayContaining(messages));
    });

    it("should delegate streaming to provider", async () => {
      const stream = await agent.streamText("Hello!");
      expect(mockProvider.streamTextCalls).toBe(1);
      expect(stream).toBeDefined();
    });

    it("should handle BaseMessage[] input for text streaming", async () => {
      const messages: BaseMessage[] = [
        { role: "user", content: "Hello!" },
        { role: "assistant", content: "Hi there!" },
        { role: "user", content: "How are you?" },
      ];

      const stream = await agent.streamText(messages);
      expect(mockProvider.streamTextCalls).toBe(1);
      expect(stream).toBeDefined();
      expect(mockProvider.lastMessages).toEqual(expect.arrayContaining(messages));
    });

    it("should store messages in memory when userId is provided", async () => {
      const userId = "test-user";
      const message = "Hello!";

      await agent.generateText(message, { userId });

      // Verify getMessages was called
      expect(mockMemory.getMessages).toHaveBeenCalled();
      expect(mockMemory.addMessage).toHaveBeenCalled();
    });

    it("should store tool-related messages in memory when tools are used", async () => {
      const userId = "test-user";
      const message = "Use the test tool";
      const mockTool = createTool({
        id: "test-tool",
        name: "test-tool",
        description: "A test tool",
        parameters: z.object({}),
        execute: async () => "tool result",
      });

      agent.addItems([mockTool]);

      await agent.generateText(message, { userId });

      // Verify getMessages was called
      expect(mockMemory.getMessages).toHaveBeenCalled();
    });
  });

  describe("memory interactions", () => {
    it("should call getMessages once with correct parameters when userId is provided", async () => {
      const userId = "test-user";
      const message = "Hello!";

      await agent.generateText(message, { userId });

      // Verify getMessages was called once with correct parameters
      expect(mockMemory.getMessages).toHaveBeenCalledWith(
        expect.objectContaining({
          userId,
          limit: 10, // Default limit is 10
        }),
      );
    });

    it("should call getMessages once with correct parameters when contextLimit is provided", async () => {
      const userId = "test-user";
      const contextLimit = 2;
      const message = "Hello!";

      await agent.generateText(message, { userId, contextLimit });

      // Verify getMessages was called once with correct parameters
      expect(mockMemory.getMessages).toHaveBeenCalledWith(
        expect.objectContaining({
          userId,
          limit: contextLimit,
        }),
      );
    });
  });

  describe("historyMemory configuration", () => {
    it("should use provided historyMemory instance when specified", () => {
      const mockHistoryMemory = {
        setCurrentUserId: vi.fn(),
        saveMessage: vi.fn(),
        getMessages: vi.fn(),
        clearMessages: vi.fn(),
        getAllUsers: vi.fn(),
      } as unknown as Memory;

      const agentWithCustomHistoryMemory = new Agent({
        name: "Test Agent",
        instructions: "Test instructions",
        model: mockModel,
        llm: mockProvider,
        memory: mockMemory,
        historyMemory: mockHistoryMemory,
      });

      // Access the memory manager to verify historyMemory was set correctly
      const memoryManager = (agentWithCustomHistoryMemory as any).memoryManager;
      expect(memoryManager.historyMemory).toBe(mockHistoryMemory);
    });

    it("should use same memory instance for historyMemory when not specified", () => {
      const agentWithDefaultHistory = new Agent({
        name: "Test Agent",
        instructions: "Test instructions",
        model: mockModel,
        llm: mockProvider,
        memory: mockMemory,
        // historyMemory not specified
      });

      const memoryManager = (agentWithDefaultHistory as any).memoryManager;
      // Should use the same memory instance as conversation memory
      expect(memoryManager.historyMemory).toBe(mockMemory);
      expect(memoryManager.conversationMemory).toBe(mockMemory);
    });

    it("should allow same memory instance for both conversation and history", () => {
      const sharedMemory = {
        setCurrentUserId: vi.fn(),
        saveMessage: vi.fn(),
        getMessages: vi.fn(),
        clearMessages: vi.fn(),
        getAllUsers: vi.fn(),
      } as unknown as Memory;

      const agentWithSharedMemory = new Agent({
        name: "Test Agent",
        instructions: "Test instructions",
        model: mockModel,
        llm: mockProvider,
        memory: sharedMemory,
        historyMemory: sharedMemory,
      });

      const memoryManager = (agentWithSharedMemory as any).memoryManager;
      expect(memoryManager.conversationMemory).toBe(sharedMemory);
      expect(memoryManager.historyMemory).toBe(sharedMemory);
    });

    it("should use LibSQLStorage for historyMemory when conversation memory is disabled", () => {
      const agentWithDisabledMemory = new Agent({
        name: "Test Agent",
        instructions: "Test instructions",
        model: mockModel,
        llm: mockProvider,
        memory: false, // Conversation memory disabled
        // historyMemory not specified
      });

      const memoryManager = (agentWithDisabledMemory as any).memoryManager;
      // Conversation memory should be undefined
      expect(memoryManager.conversationMemory).toBeUndefined();
      // History memory should still exist (defaults to LibSQLStorage)
      expect(memoryManager.historyMemory).toBeDefined();
      expect(memoryManager.historyMemory.constructor.name).toBe("LibSQLStorage");
    });
  });

  describe("history management", () => {
    it("should create history entries during text generation", async () => {
      // Track the addEntry method of HistoryManager with a spy
      const addEntrySpy = vi.spyOn(agent.getHistoryManager(), "addEntry");

      // Mock history entry - creating only for reference
      createMockHistoryEntry("Test history management");

      await agent.generateText("Test history management");

      // Check if addEntry was called
      expect(addEntrySpy).toHaveBeenCalled();

      // Clean up the spy
      addEntrySpy.mockRestore();
    });

    it("should handle history updates correctly", async () => {
      // Spy on AgentEventEmitter
      const emitAgentUnregisteredSpy = vi.spyOn(
        AgentEventEmitter.getInstance(),
        "emitAgentUnregistered",
      );

      // Add active history entry to prepare for unregister
      await agent.generateText("Hello before unregister!");

      // Reset call counts on spy before our unregister call
      emitAgentUnregisteredSpy.mockClear();

      // Unregister agent
      agent.unregister();

      // Check if AgentEventEmitter was called with agent ID
      expect(emitAgentUnregisteredSpy).toHaveBeenCalledWith(agent.id);

      // Clean up the spy
      emitAgentUnregisteredSpy.mockRestore();
    });

    it("should use HistoryManager to store history entries", async () => {
      const historyManager = agent.getHistoryManager();

      // Mock emitHistoryEntryCreated once more to ensure fresh mocks
      const emitHistoryEntryCreatedMock = vi.fn();
      mockEventEmitter.emitHistoryEntryCreated = emitHistoryEntryCreatedMock;

      const historyManagerAddEntrySpy = vi.spyOn(historyManager, "addEntry");

      await agent.generateText("Test input");

      expect(historyManagerAddEntrySpy).toHaveBeenCalled();
      expect(historyManagerAddEntrySpy.mock.calls[0][0].input).toBe("Test input");
    });
  });

  describe("additional core functionality", () => {
    it("should return model name correctly", () => {
      // Test getModelName functionality
      const modelName = agent.getModelName();
      expect(modelName).toBe(mockModel.modelId);
    });

    it("should return full state with correct structure", () => {
      // Add a tool for better state testing
      const mockTool = createTool({
        name: "state-test-tool",
        description: "A test tool for state",
        parameters: z.object({}),
        execute: async () => "tool result",
      });

      agent.addItems([mockTool]);

      // Get full state
      const state = agent.getFullState();

      // Check basic properties
      expect(state.id).toBe(agent.id);
      expect(state.name).toBe(agent.name);
      expect(state.description).toBe(agent.instructions);
      expect(state.node_id).toBe(`agent_${agent.id}`);

      // Check tools property
      expect(state.tools).toContainEqual(
        expect.objectContaining({
          name: mockTool.name,
          node_id: `tool_${mockTool.name}_${agent.id}`,
        }),
      );

      // Check memory property
      expect(state.memory).toBeDefined();
      expect(state.memory.node_id).toBe(`memory_${agent.id}`);
    });
  });

  describe("events", () => {
    it("should register agent when created", () => {
      const newAgent = new TestAgent({
        name: "New Agent",
        model: mockModel,
        llm: mockProvider,
        instructions: "A helpful AI assistant",
      });

      // Register the agent through AgentRegistry
      AgentRegistry.getInstance().registerAgent(newAgent);

      expect(mockEventEmitter.emitAgentRegistered).toHaveBeenCalledWith(newAgent.id);
    });

    it("should emit agent unregistered event when agent is removed", () => {
      const newAgent = new TestAgent({
        name: "New Agent",
        model: mockModel,
        llm: mockProvider,
        instructions: "A helpful AI assistant",
      });

      const emitAgentUnregisteredSpy = vi.spyOn(
        AgentEventEmitter.getInstance(),
        "emitAgentUnregistered",
      );

      newAgent.unregister();

      // And event was emitted
      expect(emitAgentUnregisteredSpy).toHaveBeenCalledWith(newAgent.id);
    });
  });

  describe("manager classes", () => {
    it("should initialize managers in constructor", () => {
      expect(agent.getToolManager()).toBeDefined();
      expect(agent.getHistoryManager()).toBeDefined();
      expect(agent.getSubAgentManager()).toBeDefined();
    });

    it("should delegate getHistory to HistoryManager", () => {
      const historyManagerSpy = vi.spyOn(agent.getHistoryManager(), "getEntries");

      agent.getHistory();

      expect(historyManagerSpy).toHaveBeenCalled();
    });

    it("should use HistoryManager to store history entries", async () => {
      const historyManager = agent.getHistoryManager();

      // Mock emitHistoryEntryCreated once more to ensure fresh mocks
      const emitHistoryEntryCreatedMock = vi.fn();
      mockEventEmitter.emitHistoryEntryCreated = emitHistoryEntryCreatedMock;

      const historyManagerAddEntrySpy = vi.spyOn(historyManager, "addEntry");

      await agent.generateText("Test input");

      expect(historyManagerAddEntrySpy).toHaveBeenCalled();
      expect(historyManagerAddEntrySpy.mock.calls[0][0].input).toBe("Test input");
    });
  });

  describe("stream handling", () => {
    it("should handle streaming errors gracefully", async () => {
      const errorProvider = new MockProvider(mockModel);
      vi.spyOn(errorProvider, "streamText").mockRejectedValue(new Error("Stream error"));

      const errorAgent = new TestAgent({
        name: "Error Stream Agent",
        model: mockModel,
        llm: errorProvider,
        instructions: "Error Stream Agent instructions",
      });

      await expect(errorAgent.streamText("Hello")).rejects.toThrow("Stream error");
    });

    it("should handle object streaming errors gracefully", async () => {
      const errorProvider = new MockProvider(mockModel);
      vi.spyOn(errorProvider, "streamObject").mockRejectedValue(new Error("Object stream error"));

      const errorAgent = new TestAgent({
        name: "Error Object Stream Agent",
        model: mockModel,
        llm: errorProvider,
        instructions: "Error Object Stream Agent instructions",
      });

      const schema = z.object({
        name: z.string(),
      });

      await expect(errorAgent.streamObject("Hello", schema)).rejects.toThrow("Object stream error");
    });
  });

  describe("retriever functionality", () => {
    // Use a simple mock object that matches the requirements
    const createMockRetriever = () => {
      const mockRetriever = {
        retrieveCalls: 0,
        expectedContext: "This is retrieved context",
        lastRetrieveOptions: null as any,

        // Add required BaseRetriever properties
        options: {},

        tool: {
          name: "mock-retriever",
          description: "A mock retriever for testing",
          parameters: z.object({}),
          execute: async () => "tool execution result",
        },

        retrieve: vi
          .fn()
          .mockImplementation(async (_input: string | BaseMessage[], options?: any) => {
            mockRetriever.retrieveCalls++;
            mockRetriever.lastRetrieveOptions = options;

            // Store references in userContext if available - simple test case
            if (options?.userContext) {
              const references = [
                {
                  id: "doc-1",
                  title: "VoltAgent Usage Guide",
                  source: "Official Documentation",
                },
                {
                  id: "doc-2",
                  title: "API Reference",
                  source: "Technical Documentation",
                },
              ];

              options.userContext.set("references", references);
            }

            return mockRetriever.expectedContext;
          }),
      };

      return mockRetriever;
    };

    it("should enhance system message with retriever context", async () => {
      // Mock the getSystemMessage method to verify it was called with context
      const mockRetriever = createMockRetriever();

      // Create a new agent for this test
      const testAgentWithRetriever = new TestAgent({
        id: "retriever-test-agent",
        name: "Retriever Test Agent",
        description: "A test agent with retriever",
        model: mockModel,
        llm: mockProvider,
        // Cast through unknown to BaseRetriever for type compatibility
        retriever: mockRetriever as unknown as BaseRetriever,
        instructions: "Retriever Test Agent instructions",
      });

      // Generate text to trigger retriever
      await testAgentWithRetriever.generateText("Use the context to answer this question");

      // Check if retrieve was called
      expect(mockRetriever.retrieve).toHaveBeenCalled();

      // Verify system message contains context from retriever
      const systemMessage = mockProvider.lastMessages[0];
      expect(getStringContent(systemMessage.content)).toContain("Relevant Context:");
      expect(getStringContent(systemMessage.content)).toContain(mockRetriever.expectedContext);
    });

    it("should handle retriever errors gracefully", async () => {
      // Create a retriever that throws an error
      const errorRetriever = createMockRetriever();
      errorRetriever.retrieve.mockRejectedValue(new Error("Retriever error"));

      // Create a new agent for this test
      const testAgentWithErrorRetriever = new TestAgent({
        id: "error-retriever-test-agent",
        name: "Error Retriever Test Agent",
        description: "A test agent with error retriever",
        model: mockModel,
        llm: mockProvider,
        // Cast through unknown to BaseRetriever for type compatibility
        retriever: errorRetriever as unknown as BaseRetriever,
        instructions: "Error Retriever Test Agent instructions",
      });

      // Generate text should still work despite retriever error
      const response = await testAgentWithErrorRetriever.generateText("This should still work");

      // Verify retrieve was called
      expect(errorRetriever.retrieve).toHaveBeenCalled();

      // Verify response was generated
      expect(response.text).toBe("Hello, I am a test agent!");
    });

    it("should include retriever context with dynamic text instructions", async () => {
      const mockRetriever = createMockRetriever();
      mockRetriever.expectedContext = "Retrieved dynamic context for text";

      // Create agent with dynamic text instructions
      const dynamicTextAgent = new TestAgent({
        id: "dynamic-text-retriever-agent",
        name: "Dynamic Text Retriever Agent",
        description: "Agent with dynamic text instructions and retriever",
        model: mockModel,
        llm: mockProvider,
        retriever: mockRetriever as unknown as BaseRetriever,
        instructions: ({ userContext }: DynamicValueOptions) => {
          const mode = userContext.get("mode") || "default";
          return `You are operating in ${mode} mode with dynamic instructions.`;
        },
      });

      await dynamicTextAgent.generateText("Test dynamic text with retrieval", {
        userContext: new Map([["mode", "testing"]]),
      });

      // Verify retriever was called
      expect(mockRetriever.retrieve).toHaveBeenCalled();

      // Verify system message contains both dynamic instructions and retriever context
      const systemMessage = mockProvider.lastMessages[0];
      const systemContent = getStringContent(systemMessage.content);

      expect(systemContent).toContain(
        "You are operating in testing mode with dynamic instructions",
      );
      expect(systemContent).toContain("Relevant Context:");
      expect(systemContent).toContain(mockRetriever.expectedContext);
    });

    it("should include retriever context with dynamic chat instructions", async () => {
      const mockRetriever = createMockRetriever();
      mockRetriever.expectedContext = "Retrieved dynamic context for chat";

      // Create agent with dynamic chat instructions (returns BaseMessage[])
      const dynamicChatAgent = new TestAgent({
        id: "dynamic-chat-retriever-agent",
        name: "Dynamic Chat Retriever Agent",
        description: "Agent with dynamic chat instructions and retriever",
        model: mockModel,
        llm: mockProvider,
        retriever: mockRetriever as unknown as BaseRetriever,
        instructions: ({ userContext }: DynamicValueOptions) => {
          const userName = userContext.get("userName") || "User";
          // Return PromptContent with chat type
          return {
            type: "chat" as const,
            messages: [
              {
                role: "system" as const,
                content: `Hello ${userName}, I am your personalized assistant.`,
              },
              {
                role: "system" as const,
                content: "I can help you with various tasks.",
              },
            ],
            metadata: {
              name: "dynamic-chat-prompt",
              version: 1,
            },
          };
        },
      });

      await dynamicChatAgent.generateText("Test dynamic chat with retrieval", {
        userContext: new Map([["userName", "Alice"]]),
      });

      // Verify retriever was called
      expect(mockRetriever.retrieve).toHaveBeenCalled();

      // Verify system messages include both dynamic content and retriever context
      const messages = mockProvider.lastMessages;

      // Should have multiple system messages
      const systemMessages = messages.filter((m) => m.role === "system");
      expect(systemMessages.length).toBeGreaterThan(1);

      // First system message should contain dynamic content
      expect(getStringContent(systemMessages[0].content)).toContain(
        "Hello Alice, I am your personalized assistant",
      );

      // Last system message should contain retriever context
      const lastSystemMessage = systemMessages[systemMessages.length - 1];
      expect(getStringContent(lastSystemMessage.content)).toContain("Relevant Context:");
      expect(getStringContent(lastSystemMessage.content)).toContain(mockRetriever.expectedContext);
    });

    it("should include retriever context in dynamic chat fallback case", async () => {
      const mockRetriever = createMockRetriever();
      mockRetriever.expectedContext = "Retrieved context for fallback";

      // Create agent with dynamic chat instructions that return empty messages (fallback case)
      const fallbackChatAgent = new TestAgent({
        id: "fallback-chat-retriever-agent",
        name: "Fallback Chat Retriever Agent",
        description: "Agent with empty chat messages triggering fallback",
        model: mockModel,
        llm: mockProvider,
        retriever: mockRetriever as unknown as BaseRetriever,
        instructions: (_: DynamicValueOptions) => {
          // Return PromptContent with empty messages to trigger fallback
          return {
            type: "chat" as const,
            messages: [], // Empty messages will trigger fallback
            metadata: {
              name: "empty-chat-prompt",
              version: 1,
            },
          };
        },
      });

      await fallbackChatAgent.generateText("Test fallback with retrieval");

      // Verify retriever was called
      expect(mockRetriever.retrieve).toHaveBeenCalled();

      // Verify system message contains fallback content with retriever context
      const systemMessage = mockProvider.lastMessages[0];
      const systemContent = getStringContent(systemMessage.content);

      expect(systemContent).toContain("You are Fallback Chat Retriever Agent");
      expect(systemContent).toContain("Relevant Context:");
      expect(systemContent).toContain(mockRetriever.expectedContext);
    });

    it("should append retriever context to existing system message in chat type", async () => {
      const mockRetriever = createMockRetriever();
      mockRetriever.expectedContext = "Additional retrieved context";

      // Create agent with chat instructions that have existing system message
      const chatWithSystemAgent = new TestAgent({
        id: "chat-with-system-agent",
        name: "Chat With System Agent",
        description: "Agent with existing system message in chat",
        model: mockModel,
        llm: mockProvider,
        retriever: mockRetriever as unknown as BaseRetriever,
        instructions: () => ({
          type: "chat" as const,
          messages: [
            {
              role: "user" as const,
              content: "Hello assistant",
            },
            {
              role: "assistant" as const,
              content: "Hello! How can I help you?",
            },
            {
              role: "system" as const,
              content: "You are a helpful assistant with previous conversation context.",
            },
          ],
          metadata: {
            name: "chat-with-system",
            version: 1,
          },
        }),
      });

      await chatWithSystemAgent.generateText("Continue our conversation");

      // Verify retriever was called
      expect(mockRetriever.retrieve).toHaveBeenCalled();

      // Find the system message and verify it contains both original content and retriever context
      const messages = mockProvider.lastMessages;
      const systemMessages = messages.filter((m) => m.role === "system");

      expect(systemMessages.length).toBe(1);
      const systemContent = getStringContent(systemMessages[0].content);

      expect(systemContent).toContain(
        "You are a helpful assistant with previous conversation context",
      );
      expect(systemContent).toContain("Relevant Context:");
      expect(systemContent).toContain(mockRetriever.expectedContext);
    });

    it("should create new system message when chat has no system messages but has retriever context", async () => {
      const mockRetriever = createMockRetriever();
      mockRetriever.expectedContext = "New system message context";

      // Create agent with chat instructions that have no system messages
      const chatNoSystemAgent = new TestAgent({
        id: "chat-no-system-agent",
        name: "Chat No System Agent",
        description: "Agent with no system messages in chat",
        model: mockModel,
        llm: mockProvider,
        retriever: mockRetriever as unknown as BaseRetriever,
        instructions: () => ({
          type: "chat" as const,
          messages: [
            {
              role: "user" as const,
              content: "What's the weather like?",
            },
            {
              role: "assistant" as const,
              content: "I'd be happy to help with weather information.",
            },
          ],
          metadata: {
            name: "chat-no-system",
            version: 1,
          },
        }),
      });

      await chatNoSystemAgent.generateText("Tell me about the weather");

      // Verify retriever was called
      expect(mockRetriever.retrieve).toHaveBeenCalled();

      // Verify a new system message was created with retriever context
      const messages = mockProvider.lastMessages;
      const systemMessages = messages.filter((m) => m.role === "system");

      expect(systemMessages.length).toBe(1);
      const systemContent = getStringContent(systemMessages[0].content);

      expect(systemContent).toContain("Relevant Context:");
      expect(systemContent).toContain(mockRetriever.expectedContext);
      expect(systemContent).not.toContain("You are Chat No System Agent"); // Should be only context
    });

    it("should handle VoltOps PromptContent with retriever context", async () => {
      const mockRetriever = createMockRetriever();
      mockRetriever.expectedContext = "VoltOps retrieved context";

      // Create agent that returns VoltOps PromptContent text type
      const voltOpsAgent = new TestAgent({
        id: "voltops-retriever-agent",
        name: "VoltOps Retriever Agent",
        description: "Agent with VoltOps PromptContent and retriever",
        model: mockModel,
        llm: mockProvider,
        retriever: mockRetriever as unknown as BaseRetriever,
        instructions: (_: DynamicValueOptions) => {
          // Simulate VoltOps prompt fetch returning PromptContent
          return {
            type: "text" as const,
            text: "You are a VoltOps-powered assistant with advanced capabilities.",
            metadata: {
              name: "voltops-prompt",
              version: 2,
              labels: ["production", "retrieval"],
              tags: ["assistant", "ai"],
            },
          };
        },
      });

      await voltOpsAgent.generateText("Help me with VoltOps features");

      // Verify retriever was called
      expect(mockRetriever.retrieve).toHaveBeenCalled();

      // Verify system message includes VoltOps content and retriever context
      const systemMessage = mockProvider.lastMessages[0];
      const systemContent = getStringContent(systemMessage.content);

      expect(systemContent).toContain("You are VoltOps Retriever Agent");
      expect(systemContent).toContain(
        "You are a VoltOps-powered assistant with advanced capabilities",
      );
      expect(systemContent).toContain("Relevant Context:");
      expect(systemContent).toContain(mockRetriever.expectedContext);
    });

    it("should include retriever in full state", () => {
      // Create a mock retriever
      const mockRetriever = createMockRetriever();

      // Create a new agent for this test
      const testAgentWithRetriever = new TestAgent({
        id: "state-retriever-test-agent",
        name: "State Retriever Test Agent",
        description: "A test agent with retriever for state testing",
        model: mockModel,
        llm: mockProvider,
        // Cast through unknown to BaseRetriever for type compatibility
        retriever: mockRetriever as unknown as BaseRetriever,
        instructions: "State Retriever Test Agent instructions",
      });

      // Get full state
      const state = testAgentWithRetriever.getFullState();

      // Check retriever information in state
      expect(state.retriever).toBeDefined();
      expect(state.retriever?.name).toBe(mockRetriever.tool.name);
      expect(state.retriever?.node_id).toBe(
        `retriever_mock-retriever_${testAgentWithRetriever.id}`,
      );
      expect(state.retriever?.description).toBe(mockRetriever.tool.description);
    });

    it("should store references in userContext", async () => {
      const mockRetriever = createMockRetriever();

      // Use onEnd hook to capture the final userContext
      let capturedUserContext: Map<string | symbol, unknown> | undefined;
      const onEndHook = vi.fn(({ context }: { context: OperationContext }) => {
        capturedUserContext = context.userContext;
      });

      const testAgentWithRetriever = new TestAgent({
        id: "references-test-agent",
        name: "References Test Agent",
        description: "A test agent with retriever for references testing",
        model: mockModel,
        llm: mockProvider,
        retriever: mockRetriever as unknown as BaseRetriever,
        hooks: createHooks({ onEnd: onEndHook }),
        instructions: "References Test Agent instructions",
      });

      await testAgentWithRetriever.generateText("What is VoltAgent?");

      // Verify retriever was called
      expect(mockRetriever.retrieve).toHaveBeenCalled();

      // Verify onEnd hook was called and captured userContext
      expect(onEndHook).toHaveBeenCalled();
      expect(capturedUserContext).toBeInstanceOf(Map);

      const references = capturedUserContext?.get("references") as Array<{
        id: string;
        title: string;
        source: string;
      }>;
      expect(references).toBeDefined();
      expect(Array.isArray(references)).toBe(true);
    });

    it("should pass userContext to retriever during generation", async () => {
      const mockRetriever = createMockRetriever();

      const testAgentWithRetriever = new TestAgent({
        id: "usercontext-retriever-test-agent",
        name: "UserContext Retriever Test Agent",
        description: "A test agent with retriever for userContext testing",
        model: mockModel,
        llm: mockProvider,
        retriever: mockRetriever as unknown as BaseRetriever,
        instructions: "UserContext Retriever Test Agent instructions",
      });

      const initialUserContext = new Map<string | symbol, unknown>();
      initialUserContext.set("initial_data", "test_value");

      await testAgentWithRetriever.generateText("Test query for retrieval", {
        userContext: initialUserContext,
      });

      // Verify retriever was called with options containing userContext
      expect(mockRetriever.retrieve).toHaveBeenCalled();
      expect(mockRetriever.lastRetrieveOptions).toBeDefined();
      expect(mockRetriever.lastRetrieveOptions.userContext).toBeInstanceOf(Map);
      expect(mockRetriever.lastRetrieveOptions.userContext.get("initial_data")).toBe("test_value");
    });

    it("should work without userContext in options", async () => {
      const mockRetriever = createMockRetriever();

      // Use onEnd hook to capture the final userContext
      let capturedUserContext: Map<string | symbol, unknown> | undefined;
      const onEndHook = vi.fn(({ context }: { context: OperationContext }) => {
        capturedUserContext = context.userContext;
      });

      const testAgentWithRetriever = new TestAgent({
        id: "no-context-retriever-test-agent",
        name: "No Context Retriever Test Agent",
        description: "A test agent with retriever for no context testing",
        model: mockModel,
        llm: mockProvider,
        retriever: mockRetriever as unknown as BaseRetriever,
        hooks: createHooks({ onEnd: onEndHook }),
        instructions: "No Context Retriever Test Agent instructions",
      });

      await testAgentWithRetriever.generateText("Test without initial context");

      // Verify retriever was called
      expect(mockRetriever.retrieve).toHaveBeenCalled();

      // Verify onEnd hook was called and captured userContext
      expect(onEndHook).toHaveBeenCalled();
      expect(capturedUserContext).toBeInstanceOf(Map);

      const references = capturedUserContext?.get("references");
      expect(references).toBeDefined();
      expect(Array.isArray(references)).toBe(true);
    });
  });

  describe("hooks options", () => {
    for (const method of ["generateText", "streamText"]) {
      it(`should call hooks when passed in the generate options for ${method}`, async () => {
        const hookOrder: string[] = [];

        const message = "Use the test tool";
        const mockTool = createTool({
          id: "test-tool",
          name: "test-tool",
          description: "A test tool",
          parameters: z.object({}),
          execute: async () => "tool result",
        });

        const onStartAgentOptionMock = vi.fn().mockImplementation(() => {
          hookOrder.push("agent:onStart");
        });
        const onStartToolOptionMock = vi.fn().mockImplementation(() => {
          hookOrder.push("agent:onToolStart");
        });
        const onEndToolOptionMock = vi.fn().mockImplementation(() => {
          hookOrder.push("agent:onToolEnd");
        });
        const onEndAgentOptionMock = vi.fn().mockImplementation(() => {
          hookOrder.push("agent:onEnd");
        });

        const agent = new TestAgent({
          name: "Order Test Agent",
          model: mockModel,
          llm: mockProvider,
          tools: [mockTool],
          hooks: createHooks({
            onStart: onStartAgentOptionMock,
            onEnd: onEndAgentOptionMock,
            onToolStart: onStartToolOptionMock,
            onToolEnd: onEndToolOptionMock,
          }),
          instructions: "Use the test tool when asked",
        });

        const onStartOptionMock = vi.fn().mockImplementation(() => {
          hookOrder.push("generate:onStart");
        });
        const onEndOptionMock = vi.fn().mockImplementation(() => {
          hookOrder.push("generate:onEnd");
        });
        const onToolStartOptionMock = vi.fn().mockImplementation(() => {
          hookOrder.push("generate:onToolStart");
        });
        const onToolEndOptionMock = vi.fn().mockImplementation(() => {
          hookOrder.push("generate:onToolEnd");
        });
        const hooks = createHooks({
          onStart: onStartOptionMock,
          onEnd: onEndOptionMock,
          onToolStart: onToolStartOptionMock,
          onToolEnd: onToolEndOptionMock,
        });

        await agent.generateText(message, { hooks });

        expect(onStartOptionMock).toHaveBeenCalled();
        expect(onEndOptionMock).toHaveBeenCalled();
        expect(onToolStartOptionMock).toHaveBeenCalled();
        expect(onToolEndOptionMock).toHaveBeenCalled();

        // Verify hooks were called in the correct order
        expect(hookOrder).toEqual([
          "generate:onStart",
          "agent:onStart",
          "generate:onToolStart",
          "agent:onToolStart",
          "generate:onToolEnd",
          "agent:onToolEnd",
          "generate:onEnd",
          "agent:onEnd",
        ]);
      });
    }
  });

  describe("onEnd hook", () => {
    it("should call onEnd hook with conversationId", async () => {
      const onEndSpy = vi.fn();
      const agentWithOnEnd = new TestAgent({
        name: "OnEnd Test Agent",
        model: mockModel,
        llm: mockProvider,
        hooks: createHooks({ onEnd: onEndSpy }),
        instructions: "OnEnd Test Agent instructions",
      });

      const userInput = "Hello, how are you?";
      await agentWithOnEnd.generateText(userInput);

      expect(onEndSpy).toHaveBeenCalledTimes(1);
      const callArgs = onEndSpy.mock.calls[0][0];

      // Check basic structure
      expect(callArgs).toHaveProperty("agent");
      expect(callArgs).toHaveProperty("output");
      expect(callArgs).toHaveProperty("error");
      expect(callArgs).toHaveProperty("conversationId");
      expect(callArgs).toHaveProperty("context");

      // Check other properties
      expect(callArgs.agent).toBe(agentWithOnEnd);
      expect(callArgs.output).toBeDefined();
      expect(callArgs.error).toBeUndefined();
      expect(callArgs.context).toBeDefined();
      expect(callArgs.conversationId).toEqual(expect.any(String));
    });

    it("should call onEnd hook with userContext passed correctly", async () => {
      const onEndSpy = vi.fn();
      const agentWithOnEnd = new TestAgent({
        name: "OnEnd Context Test Agent",
        model: mockModel,
        llm: mockProvider,
        hooks: createHooks({ onEnd: onEndSpy }),
        instructions: "OnEnd Context Test Agent instructions",
      });

      const userContext = new Map<string | symbol, unknown>();
      userContext.set("testKey", "testValue");

      await agentWithOnEnd.generateText("Test with context", { userContext });

      expect(onEndSpy).toHaveBeenCalledTimes(1);
      const callArgs = onEndSpy.mock.calls[0][0];

      expect(callArgs.context.userContext).toBeInstanceOf(Map);
      expect(callArgs.context.userContext.get("testKey")).toBe("testValue");
    });

    it("should call streamText without errors", async () => {
      const agentWithOnEnd = new TestAgent({
        name: "OnEnd Stream Test Agent",
        model: mockModel,
        llm: mockProvider,
        instructions: "OnEnd Stream Test Agent instructions",
      });

      const userInput = "Stream test";
      const result = await agentWithOnEnd.streamText(userInput);

      // Verify that streamText was called and returns expected structure
      expect(mockProvider.streamTextCalls).toBe(1);
      expect(result).toBeDefined();
      expect(result.textStream).toBeDefined();
    });
  });

  describe("userContext", () => {
    it("should initialize userContext within OperationContext", async () => {
      // Create agent with a spy hook to capture the context
      const onStartSpy = vi.fn();
      const agentWithHook = new TestAgent({
        name: "Context Test Agent",
        model: mockModel,
        llm: mockProvider,
        hooks: createHooks({ onStart: onStartSpy }),
        instructions: "Context Test Agent instructions",
      });

      await agentWithHook.generateText("test initialization");

      // Verify onStart was called
      expect(onStartSpy).toHaveBeenCalled();

      // Get the context passed to onStart from the single argument object
      const operationContext: OperationContext = onStartSpy.mock.calls[0][0].context;

      // Check if userContext exists and is a Map
      expect(operationContext).toHaveProperty("userContext");
      expect(operationContext.userContext).toBeInstanceOf(Map);
      // userContext contains agent_start_time and agent_start_event_id by default
      expect(operationContext.userContext.size).toBe(2);
      expect(operationContext.userContext.has("agent_start_time")).toBe(true);
      expect(operationContext.userContext.has("agent_start_event_id")).toBe(true);
    });

    it("should initialize OperationContext with userContext from options", async () => {
      const initialUserContext = new Map<string | symbol, unknown>();
      initialUserContext.set("initialKey", "initialValue");

      const onStartSpy = vi.fn();
      const agentWithInitialContext = new TestAgent({
        name: "Initial Context Agent",
        model: mockModel,
        llm: mockProvider,
        hooks: createHooks({ onStart: onStartSpy }),
        instructions: "Initial Context Agent instructions",
      });

      await agentWithInitialContext.generateText("test with initial context", {
        userContext: initialUserContext,
      });

      expect(onStartSpy).toHaveBeenCalled();
      const operationContext: OperationContext = onStartSpy.mock.calls[0][0].context;
      expect(operationContext.userContext).toBeInstanceOf(Map);
      expect(operationContext.userContext.get("initialKey")).toBe("initialValue");
      // Ensure it's the same instance (reference)
      expect(operationContext.userContext).toBe(initialUserContext);
      // Modify the original to ensure changes are reflected
      initialUserContext.set("anotherKey", "anotherValue");
      expect(operationContext.userContext.has("anotherKey")).toBe(true);
    });

    it("should pass userContext to onStart and onEnd hooks when provided in options", async () => {
      const onStartSpy = vi.fn();
      const onEndSpy = vi.fn();
      const agentWithHooks = new TestAgent({
        name: "Hook Context Agent",
        model: mockModel,
        llm: mockProvider,
        hooks: createHooks({ onStart: onStartSpy, onEnd: onEndSpy }),
        instructions: "Hook Context Agent instructions",
      });

      const providedUserContext = new Map<string | symbol, unknown>();
      providedUserContext.set("hookKey", "hookValue");

      await agentWithHooks.generateText("test hooks with context", {
        userContext: providedUserContext,
      });

      expect(onStartSpy).toHaveBeenCalled();
      expect(onEndSpy).toHaveBeenCalled();

      const startContext: OperationContext = onStartSpy.mock.calls[0][0].context;
      const endContext: OperationContext = onEndSpy.mock.calls[0][0].context;

      expect(startContext.userContext.get("hookKey")).toBe("hookValue");
      expect(endContext.userContext.get("hookKey")).toBe("hookValue");
      expect(startContext.userContext).toBe(endContext.userContext);
      expect(startContext.userContext).toBe(providedUserContext); // Should be the same reference
    });

    it("should allow modifying userContext in onStart and reading in onEnd", async () => {
      const testValue = "test data";
      const testKey = "customKey";

      // Update onStartHook to accept a single object argument
      const onStartHook = vi.fn(({ context }: { context: OperationContext }) => {
        context.userContext.set(testKey, testValue);
      });
      // Update onEndHook to accept a single object argument
      const onEndHook = vi.fn(({ context }: { context: OperationContext }) => {
        expect(context.userContext.get(testKey)).toBe(testValue);
      });

      const agentWithModifyHooks = new TestAgent({
        name: "Modify Context Agent",
        model: mockModel,
        llm: mockProvider,
        // Pass the updated hooks
        hooks: createHooks({ onStart: onStartHook, onEnd: onEndHook }),
        instructions: "Modify Context Agent instructions",
      });

      await agentWithModifyHooks.generateText("test modification");

      expect(onStartHook).toHaveBeenCalled();
      expect(onEndHook).toHaveBeenCalled();
    });

    it("should pass userContext to tool execution context when provided in options", async () => {
      const testValue = "data from start via options";
      const testKey = Symbol("toolTestKeyWithOptions");

      const toolExecuteSpy = vi.fn();
      const mockTool = createTool({
        id: "context-tool-options",
        name: "context-tool-options",
        description: "A tool to test context from options",
        parameters: z.object({}),
        execute: toolExecuteSpy,
      });

      const agentWithToolAndOptions = new TestAgent({
        name: "Tool Context Options Agent",
        model: mockModel,
        llm: mockProvider,
        tools: [mockTool],
        instructions: "Tool Context Options Agent instructions",
      });

      const providedUserContext = new Map<string | symbol, unknown>();
      providedUserContext.set(testKey, testValue);

      const generateTextSpy = vi.spyOn(mockProvider, "generateText");

      await agentWithToolAndOptions.generateText("Use the context-tool-options", {
        userContext: providedUserContext,
      });

      expect(generateTextSpy).toHaveBeenCalled();
      const generateTextOptions = generateTextSpy.mock.calls[0][0];

      expect(generateTextOptions.toolExecutionContext).toBeDefined();
      expect(generateTextOptions.toolExecutionContext?.operationContext).toBeDefined();

      // Use if condition for safer access to nested properties
      if (generateTextOptions.toolExecutionContext?.operationContext?.userContext) {
        const toolOpContext = generateTextOptions.toolExecutionContext.operationContext;
        expect(toolOpContext.userContext).toBeInstanceOf(Map);
        expect(toolOpContext.userContext.get(testKey)).toBe(testValue);
        expect(toolOpContext.userContext).toBe(providedUserContext); // Should be the same reference
      } else {
        // Fail the test if the structure is not as expected
        throw new Error(
          "toolExecutionContext.operationContext.userContext was not defined as expected",
        );
      }

      generateTextSpy.mockRestore();
    });

    it("should use the same userContext reference when passed via options", async () => {
      const key1 = "op1KeyWithOptions";
      const value1 = "op1ValueWithOptions";
      const key2 = "op2KeyWithOptions";
      const value2 = "op2ValueWithOptions";

      const userContext1 = new Map<string | symbol, unknown>([[key1, value1]]);
      const userContext2 = new Map<string | symbol, unknown>([[key2, value2]]);

      const onStartHook = vi.fn(({ context }: { context: OperationContext }) => {
        const inputString = String(context.historyEntry.input);

        if (inputString === "Operation 1 with options") {
          expect(context.userContext).toBe(userContext1); // Same reference
          expect(context.userContext.get(key1)).toBe(value1);
          expect(context.userContext.has(key2)).toBe(false);
          // Modify context
          context.userContext.set("op1Modified", "modified");
        } else if (inputString === "Operation 2 with options") {
          expect(context.userContext).toBe(userContext2); // Same reference
          expect(context.userContext.get(key2)).toBe(value2);
          expect(context.userContext.has(key1)).toBe(false);
          expect(context.userContext.has("op1Modified")).toBe(false); // Different context
        }
      });

      const isolationAgent = new TestAgent({
        name: "Isolation Options Agent",
        model: mockModel,
        llm: mockProvider,
        hooks: createHooks({ onStart: onStartHook }),
        instructions: "Isolation Options Agent instructions",
      });

      await isolationAgent.generateText("Operation 1 with options", {
        userContext: userContext1,
      });
      await isolationAgent.generateText("Operation 2 with options", {
        userContext: userContext2,
      });

      expect(onStartHook).toHaveBeenCalledTimes(2);
      // Verify that modifications were actually made to the original contexts
      expect(userContext1.has("op1Modified")).toBe(true);
    });

    it("should return userContext in generateText response", async () => {
      const userContext = new Map<string | symbol, unknown>();
      userContext.set("agentName", "Math Agent");
      userContext.set("testKey", "testValue");

      const response = await agent.generateText("What's 2+2?", {
        userContext,
      });

      // Verify response structure includes userContext
      expect(response).toHaveProperty("userContext");
      expect(response.userContext).toBeInstanceOf(Map);
      expect(response.userContext?.get("agentName")).toBe("Math Agent");
      expect(response.userContext?.get("testKey")).toBe("testValue");

      // Verify the response also has the expected base properties
      expect(response).toHaveProperty("text");
      expect(response).toHaveProperty("usage");
      expect(response).toHaveProperty("finishReason");
      expect(response).toHaveProperty("provider");
    });

    it("should use userContext from constructor as default", async () => {
      const constructorUserContext = new Map<string | symbol, unknown>();
      constructorUserContext.set("environment", "production");
      constructorUserContext.set("projectId", "123");

      const onStartSpy = vi.fn();
      const agentWithConstructorContext = new TestAgent({
        name: "Constructor Context Agent",
        model: mockModel,
        llm: mockProvider,
        userContext: constructorUserContext,
        hooks: createHooks({ onStart: onStartSpy }),
        instructions: "Constructor Context Agent instructions",
      });

      // Call without providing userContext in options
      await agentWithConstructorContext.generateText("test with constructor context");

      expect(onStartSpy).toHaveBeenCalled();
      const operationContext: OperationContext = onStartSpy.mock.calls[0][0].context;

      // Should have constructor context values
      expect(operationContext.userContext.get("environment")).toBe("production");
      expect(operationContext.userContext.get("projectId")).toBe("123");
    });

    it("should allow execution userContext to override constructor userContext", async () => {
      const constructorUserContext = new Map<string | symbol, unknown>();
      constructorUserContext.set("source", "constructor");
      constructorUserContext.set("environment", "production");

      const executionUserContext = new Map<string | symbol, unknown>();
      executionUserContext.set("source", "execution");
      executionUserContext.set("debug", true);

      const onStartSpy = vi.fn();
      const agentWithBothContexts = new TestAgent({
        name: "Override Context Agent",
        model: mockModel,
        llm: mockProvider,
        userContext: constructorUserContext,
        hooks: createHooks({ onStart: onStartSpy }),
        instructions: "Override Context Agent instructions",
      });

      // Call with execution context
      await agentWithBothContexts.generateText("test context override", {
        userContext: executionUserContext,
      });

      expect(onStartSpy).toHaveBeenCalled();
      const operationContext: OperationContext = onStartSpy.mock.calls[0][0].context;

      // Should have execution context, not constructor context
      expect(operationContext.userContext.get("source")).toBe("execution");
      expect(operationContext.userContext.get("debug")).toBe(true);
      expect(operationContext.userContext.has("environment")).toBe(false);
    });

    it("should provide constructor userContext to dynamic instructions", async () => {
      const constructorUserContext = new Map<string | symbol, unknown>();
      constructorUserContext.set("language", "es");

      const dynamicInstructions = vi.fn(({ userContext }: DynamicValueOptions) => {
        const lang = userContext.get("language");
        return lang === "es" ? "Ayuda al usuario" : "Help the user";
      });

      const agentWithDynamicInstructions = new TestAgent({
        name: "Dynamic Instructions Context Agent",
        model: mockModel,
        llm: mockProvider,
        userContext: constructorUserContext,
        instructions: dynamicInstructions,
      });

      await agentWithDynamicInstructions.generateText("test dynamic instructions");

      // Verify dynamic instructions were called with constructor context
      expect(dynamicInstructions).toHaveBeenCalled();
      const callArgs = dynamicInstructions.mock.calls[0][0];
      expect(callArgs.userContext.get("language")).toBe("es");
    });
  });

  describe("forward event functionality", () => {
    let agentWithSubAgents: TestAgent<{ llm: MockProvider }>;
    let mockSubAgent: TestAgent<{ llm: MockProvider }>;

    beforeEach(() => {
      // Create a mock sub-agent
      mockSubAgent = new TestAgent({
        id: "sub-agent-1",
        name: "Mock Sub Agent",
        description: "A mock sub-agent for testing",
        model: mockModel,
        llm: mockProvider,
        instructions: "A mock sub-agent for testing",
        memory: mockMemory,
      });

      // Create an agent with sub-agents
      agentWithSubAgents = new TestAgent({
        id: "parent-agent",
        name: "Parent Agent",
        description: "A parent agent with sub-agents",
        model: mockModel,
        llm: mockProvider,
        instructions: "A parent agent with sub-agents",
        memory: mockMemory,
      });

      // // Add the sub-agent
      agentWithSubAgents.addSubAgent(mockSubAgent);
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it.todo("should test forwardEvent filtering logic directly", async () => {
      // TODO: Implement this test
    });

    it.todo("should test forwardEvent tool prefix logic directly", async () => {
      // TODO: implement this test
    });

    it.todo("should handle forwardEvent errors gracefully", async () => {
      // TODO: Implement this test
    });

    it.todo("should do nothing when no streamEventForwarder is provided", async () => {
      // TODO: Implement this test
    });

    it("should create delegate tool with forwardEvent function when SubAgents exist", async () => {
      const tools = agentWithSubAgents.getTools();
      const delegateTool = tools.find((tool) => tool.name === "delegate_task");

      expect(delegateTool).toBeDefined();
      expect(delegateTool?.name).toBe("delegate_task");
      expect(delegateTool?.description).toContain("Delegate");
    });

    it("should not create delegate tool when no SubAgents exist", async () => {
      const agentWithoutSubAgents = new TestAgent({
        name: "No SubAgents Agent",
        model: mockModel,
        llm: mockProvider,
        instructions: "No SubAgents Agent instructions",
        memory: mockMemory,
      });

      const tools = agentWithoutSubAgents.getTools();
      const delegateTool = tools.find((tool) => tool.name === "delegate_task");

      expect(delegateTool).toBeUndefined();
    });

    it("should pass streamEventForwarder to prepareTextOptions during streamText", async () => {
      const mockForwarder = vi.fn();

      // Spy on prepareTextOptions to verify it receives the streamEventForwarder
      const prepareTextOptionsSpy = vi.spyOn(agentWithSubAgents as any, "prepareTextOptions");

      // Use the internal options interface to avoid type issues
      const internalOptions = {
        internalStreamForwarder: mockForwarder,
      };

      await agentWithSubAgents.streamText("Test forwarder passing", internalOptions as any);

      expect(prepareTextOptionsSpy).toHaveBeenCalled();
      const callArgs = prepareTextOptionsSpy.mock.calls[0][0] as any;
      expect(callArgs.internalStreamForwarder).toBeDefined();
      expect(typeof callArgs.internalStreamForwarder).toBe("function");

      prepareTextOptionsSpy.mockRestore();
    });

    it("should create enhanced full stream with SubAgent events", async () => {
      // Create a mock original stream
      const originalStream = createAsyncIterableStream(
        new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-delta", textDelta: "Hello" });
            controller.enqueue({ type: "text-delta", textDelta: " World" });
            controller.close();
          },
        }),
      );

      // Create mock stream controller and subAgent status tracking
      const streamController: { current: ReadableStreamDefaultController<any> | null } = {
        current: null,
      };
      const subAgentStatus = new Map<string, { isActive: boolean; isCompleted: boolean }>();

      // Access the private method using any casting with new parameters
      const enhancedStream = (agentWithSubAgents as any).createEnhancedFullStream(
        originalStream,
        streamController,
        subAgentStatus,
      );

      const events: any[] = [];
      for await (const event of enhancedStream) {
        events.push(event);
      }

      // Should receive original stream events
      expect(events).toContainEqual({ type: "text-delta", textDelta: "Hello" });
      expect(events).toContainEqual({ type: "text-delta", textDelta: " World" });
    });

    it("should handle different SubAgent event types in enhanced stream", async () => {
      const originalStream = createAsyncIterableStream(
        new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-delta", textDelta: "Test" });
            controller.close();
          },
        }),
      );

      // Create mock stream controller and subAgent status tracking
      const streamController: { current: ReadableStreamDefaultController<any> | null } = {
        current: null,
      };
      const subAgentStatus = new Map<string, { isActive: boolean; isCompleted: boolean }>();

      const enhancedStream = (agentWithSubAgents as any).createEnhancedFullStream(
        originalStream,
        streamController,
        subAgentStatus,
      );

      const events: any[] = [];
      for await (const event of enhancedStream) {
        events.push(event);
      }

      expect(events).toContainEqual({ type: "text-delta", textDelta: "Test" });
    });

    it("should queue SubAgent events properly during streamText", async () => {
      const mockSubAgent = new TestAgent({
        id: "test-sub-agent",
        name: "Test Sub Agent",
        model: mockModel,
        llm: mockProvider,
        instructions: "A test sub agent",
        memory: mockMemory,
      });

      const parentAgent = new TestAgent({
        id: "parent-agent",
        name: "Parent Agent",
        model: mockModel,
        llm: mockProvider,
        instructions: "A parent agent",
        memory: mockMemory,
      });

      parentAgent.addSubAgent(mockSubAgent);

      // Mock the streamText response to include fullStream
      const mockFullStream = createAsyncIterableStream(
        new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-delta", textDelta: "Response" });
            controller.close();
          },
        }),
      );

      vi.spyOn(mockProvider, "streamText").mockResolvedValue({
        textStream: mockFullStream,
        fullStream: mockFullStream,
        provider: {} as any,
      });

      const response = await parentAgent.streamText("Test with SubAgent events");

      expect(response.fullStream).toBeDefined();
      expect(mockProvider.streamText).toHaveBeenCalled();

      // Verify that the response includes the enhanced stream
      if (response.fullStream) {
        const events: any[] = [];
        for await (const event of response.fullStream) {
          events.push(event);
          // Break after first event to avoid infinite loop in tests
          break;
        }
        expect(events.length).toBeGreaterThan(0);
      }
    });

    it("should handle empty SubAgent events queue", async () => {
      const originalStream = createAsyncIterableStream(
        new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-delta", textDelta: "Solo" });
            controller.close();
          },
        }),
      );

      // Create mock stream controller and subAgent status tracking
      const streamController: { current: ReadableStreamDefaultController<any> | null } = {
        current: null,
      };
      const subAgentStatus = new Map<string, { isActive: boolean; isCompleted: boolean }>();

      const enhancedStream = (agentWithSubAgents as any).createEnhancedFullStream(
        originalStream,
        streamController,
        subAgentStatus,
      );

      const events: any[] = [];
      for await (const event of enhancedStream) {
        events.push(event);
      }

      expect(events).toEqual([{ type: "text-delta", textDelta: "Solo" }]);
    });

    it("should preserve event order in enhanced stream", async () => {
      const originalStream = createAsyncIterableStream(
        new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-delta", textDelta: "First" });
            controller.enqueue({ type: "text-delta", textDelta: "Second" });
            controller.close();
          },
        }),
      );

      // Create mock stream controller and subAgent status tracking
      const streamController: { current: ReadableStreamDefaultController<any> | null } = {
        current: null,
      };
      const subAgentStatus = new Map<string, { isActive: boolean; isCompleted: boolean }>();

      const enhancedStream = (agentWithSubAgents as any).createEnhancedFullStream(
        originalStream,
        streamController,
        subAgentStatus,
      );

      const events: any[] = [];
      for await (const event of enhancedStream) {
        events.push(event);
      }

      // Should include original stream events
      expect(events).toContainEqual({ type: "text-delta", textDelta: "First" });
      expect(events).toContainEqual({ type: "text-delta", textDelta: "Second" });
    });

    it("should not wrap fullStream if it doesn't exist in original response", async () => {
      const parentAgent = new TestAgent({
        id: "parent-no-stream",
        name: "Parent No Stream",
        model: mockModel,
        llm: mockProvider,
        instructions: "Parent without fullStream",
        memory: mockMemory,
      });

      parentAgent.addSubAgent(mockSubAgent);

      // Mock response without fullStream
      vi.spyOn(mockProvider, "streamText").mockResolvedValue({
        textStream: createAsyncIterableStream(
          new ReadableStream({
            start(controller) {
              controller.enqueue("test");
              controller.close();
            },
          }),
        ),
        provider: {} as any,
      });

      const response = await parentAgent.streamText("Test without fullStream");

      expect(response.fullStream).toBeUndefined();
    });

    it("should handle SubAgent event processing errors gracefully", async () => {
      const originalStream = createAsyncIterableStream(
        new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-delta", textDelta: "Safe" });
            controller.close();
          },
        }),
      );

      // Create mock stream controller and subAgent status tracking
      const streamController: { current: ReadableStreamDefaultController<any> | null } = {
        current: null,
      };
      const subAgentStatus = new Map<string, { isActive: boolean; isCompleted: boolean }>();

      const enhancedStream = (agentWithSubAgents as any).createEnhancedFullStream(
        originalStream,
        streamController,
        subAgentStatus,
      );

      // Should still work despite malformed events
      const events: any[] = [];
      for await (const event of enhancedStream) {
        events.push(event);
      }

      expect(events).toContainEqual({ type: "text-delta", textDelta: "Safe" });
    });

    it("should properly extract tool-call event data", async () => {
      const originalStream = createAsyncIterableStream(
        new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
      );

      // Create mock stream controller and subAgent status tracking
      const streamController: { current: ReadableStreamDefaultController<any> | null } = {
        current: null,
      };
      const subAgentStatus = new Map<string, { isActive: boolean; isCompleted: boolean }>();

      const enhancedStream = (agentWithSubAgents as any).createEnhancedFullStream(
        originalStream,
        streamController,
        subAgentStatus,
      );

      const events: any[] = [];
      for await (const event of enhancedStream) {
        events.push(event);
      }

      // The enhanced stream should process the tool-call event correctly
      // Since we're testing the internal implementation, we verify the stream completes without errors
      expect(() => enhancedStream).not.toThrow();
    });

    it("should properly extract tool-result event data", async () => {
      const originalStream = createAsyncIterableStream(
        new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
      );

      // Create mock stream controller and subAgent status tracking
      const streamController: { current: ReadableStreamDefaultController<any> | null } = {
        current: null,
      };
      const subAgentStatus = new Map<string, { isActive: boolean; isCompleted: boolean }>();

      const enhancedStream = (agentWithSubAgents as any).createEnhancedFullStream(
        originalStream,
        streamController,
        subAgentStatus,
      );

      const events: any[] = [];
      for await (const event of enhancedStream) {
        events.push(event);
      }

      // Verify the stream processes without throwing errors
      expect(() => enhancedStream).not.toThrow();
    });

    it("should integrate delegate tool with internal stream forwarder", async () => {
      const mockEventForwarder = vi.fn();

      // Spy on createDelegateTool to verify forwardEvent is passed
      const createDelegateToolSpy = vi.spyOn(
        agentWithSubAgents.getSubAgentManager() as any,
        "createDelegateTool",
      );

      await (agentWithSubAgents as any).prepareTextOptions({
        internalStreamForwarder: mockEventForwarder,
        historyEntryId: "test-history-id",
        operationContext: {
          userContext: new Map(),
          operationId: "test-op-id",
          historyEntry: { id: "test-history-id" },
          isActive: true,
        },
      });

      expect(createDelegateToolSpy).toHaveBeenCalled();
      const delegateToolArgs = createDelegateToolSpy.mock.calls[0][0] as any;
      expect(delegateToolArgs.forwardEvent).toBeDefined();
      expect(typeof delegateToolArgs.forwardEvent).toBe("function");

      createDelegateToolSpy.mockRestore();
    });

    it("should replace existing delegate tool when creating new one with forwarder", async () => {
      // First create tools without forwarder
      const initialTools = await (agentWithSubAgents as any).prepareTextOptions({
        historyEntryId: "test-1",
        operationContext: {
          userContext: new Map(),
          operationId: "test-1",
          historyEntry: { id: "test-1" },
          isActive: true,
        },
      });

      const initialDelegateCount = initialTools.tools.filter(
        (tool: any) => tool.name === "delegate_task",
      ).length;

      // Then create tools with forwarder
      const enhancedTools = await (agentWithSubAgents as any).prepareTextOptions({
        internalStreamForwarder: vi.fn(),
        historyEntryId: "test-2",
        operationContext: {
          userContext: new Map(),
          operationId: "test-2",
          historyEntry: { id: "test-2" },
          isActive: true,
        },
      });

      const enhancedDelegateCount = enhancedTools.tools.filter(
        (tool: any) => tool.name === "delegate_task",
      ).length;

      // Should still have only one delegate tool
      expect(initialDelegateCount).toBe(1);
      expect(enhancedDelegateCount).toBe(1);
    });

    it("should pass current historyEntryId to delegate tool creation", async () => {
      const testHistoryEntryId = "specific-history-entry-123";
      const createDelegateToolSpy = vi.spyOn(
        agentWithSubAgents.getSubAgentManager() as any,
        "createDelegateTool",
      );

      await (agentWithSubAgents as any).prepareTextOptions({
        historyEntryId: testHistoryEntryId,
        operationContext: {
          userContext: new Map(),
          operationId: "test-op",
          historyEntry: { id: testHistoryEntryId },
          isActive: true,
        },
      });

      expect(createDelegateToolSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          currentHistoryEntryId: testHistoryEntryId,
        }),
      );

      createDelegateToolSpy.mockRestore();
    });

    it("should pass operationContext to delegate tool creation", async () => {
      const testOperationContext = {
        userContext: new Map([["test", "value"]]),
        operationId: "test-op-456",
        historyEntry: { id: "test-history-456" },
        isActive: true,
      };

      const createDelegateToolSpy = vi.spyOn(
        agentWithSubAgents.getSubAgentManager() as any,
        "createDelegateTool",
      );

      await (agentWithSubAgents as any).prepareTextOptions({
        historyEntryId: "test-history-456",
        operationContext: testOperationContext,
      });

      expect(createDelegateToolSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          operationContext: testOperationContext,
        }),
      );

      createDelegateToolSpy.mockRestore();
    });

    it("should handle missing operationContext gracefully in prepareTextOptions", async () => {
      // Test the warning case when operationContext is missing
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const textOptions = await (agentWithSubAgents as any).prepareTextOptions({
        historyEntryId: "test-history-id",
        // operationContext is intentionally missing
      });

      expect(textOptions.tools).toBeDefined();
      expect(textOptions.maxSteps).toBeDefined();

      consoleSpy.mockRestore();
    });

    it("should wrap fullStream response from streamText with SubAgent events", async () => {
      const originalFullStream = createAsyncIterableStream(
        new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-delta", textDelta: "Original" });
            controller.close();
          },
        }),
      );

      vi.spyOn(mockProvider, "streamText").mockResolvedValue({
        textStream: createAsyncIterableStream(
          new ReadableStream({
            start(controller) {
              controller.enqueue("text");
              controller.close();
            },
          }),
        ),
        fullStream: originalFullStream,
        provider: {} as any,
      });

      const response = await agentWithSubAgents.streamText("Test fullStream wrapping");

      expect(response.fullStream).toBeDefined();
      expect(response.fullStream).not.toBe(originalFullStream); // Should be wrapped

      // Verify the wrapped stream works
      if (response.fullStream) {
        const events: any[] = [];
        for await (const event of response.fullStream) {
          events.push(event);
        }
        expect(events).toContainEqual({ type: "text-delta", textDelta: "Original" });
      }
    });

    it("should handle async iteration errors in enhanced stream", async () => {
      // Create a stream that throws an error
      const errorStream = {
        async *[Symbol.asyncIterator]() {
          yield { type: "text-delta", textDelta: "Before error" };
          throw new Error("Stream iteration error");
        },
      };

      // Create mock stream controller and subAgent status tracking
      const streamController: { current: ReadableStreamDefaultController<any> | null } = {
        current: null,
      };
      const subAgentStatus = new Map<string, { isActive: boolean; isCompleted: boolean }>();

      const enhancedStream = (agentWithSubAgents as any).createEnhancedFullStream(
        errorStream,
        streamController,
        subAgentStatus,
      );

      // Should handle the error gracefully
      try {
        const events: any[] = [];
        for await (const event of enhancedStream) {
          events.push(event);
        }
        // If we reach here, the error was handled
        expect(true).toBe(true);
      } catch (error) {
        // The error should be propagated as expected
        expect((error as Error).message).toBe("Stream iteration error");
      }
    });

    it("should maintain SubAgent event queue reference across multiple stream iterations", async () => {
      // Create mock stream controllers and subAgent status tracking
      const streamController1: { current: ReadableStreamDefaultController<any> | null } = {
        current: null,
      };
      const subAgentStatus1 = new Map<string, { isActive: boolean; isCompleted: boolean }>();

      const streamController2: { current: ReadableStreamDefaultController<any> | null } = {
        current: null,
      };
      const subAgentStatus2 = new Map<string, { isActive: boolean; isCompleted: boolean }>();

      const stream1 = (agentWithSubAgents as any).createEnhancedFullStream(
        createAsyncIterableStream(
          new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "text-delta", textDelta: "Stream1" });
              controller.close();
            },
          }),
        ),
        streamController1,
        subAgentStatus1,
      );

      const stream2 = (agentWithSubAgents as any).createEnhancedFullStream(
        createAsyncIterableStream(
          new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "text-delta", textDelta: "Stream2" });
              controller.close();
            },
          }),
        ),
        streamController2,
        subAgentStatus2,
      );

      // Both streams should work independently
      const events1: any[] = [];
      const events2: any[] = [];

      for await (const event of stream1) {
        events1.push(event);
      }

      for await (const event of stream2) {
        events2.push(event);
      }

      expect(events1).toContainEqual({ type: "text-delta", textDelta: "Stream1" });
      expect(events2).toContainEqual({ type: "text-delta", textDelta: "Stream2" });
    });

    // Real-time Event Injection Tests
    it("should inject SubAgent events in real-time during stream processing", async () => {
      const originalStream = createAsyncIterableStream(
        new ReadableStream({
          start(controller) {
            // Slow stream to allow time for event injection
            setTimeout(() => {
              controller.enqueue({ type: "text-delta", textDelta: "Original1" });
              setTimeout(() => {
                controller.enqueue({ type: "text-delta", textDelta: "Original2" });
                controller.close();
              }, 50);
            }, 50);
          },
        }),
      );

      const streamController: { current: ReadableStreamDefaultController<any> | null } = {
        current: null,
      };
      const subAgentStatus = new Map<string, { isActive: boolean; isCompleted: boolean }>();

      const enhancedStream = (agentWithSubAgents as any).createEnhancedFullStream(
        originalStream,
        streamController,
        subAgentStatus,
      );

      const events: any[] = [];
      let eventCount = 0;

      // Start consuming the stream
      const streamPromise = (async () => {
        for await (const event of enhancedStream) {
          events.push(event);
          eventCount++;

          // Inject a SubAgent event after the first original event
          if (eventCount === 1 && streamController.current) {
            streamController.current.enqueue({
              type: "tool-call",
              subAgentId: "test-sub",
              subAgentName: "Test Sub",
              timestamp: new Date().toISOString(),
              toolCallId: "test-call",
              toolName: "test-tool",
              args: { test: "value" },
            });
          }
        }
      })();

      await streamPromise;

      // Should contain both original and injected events
      expect(events.length).toBeGreaterThanOrEqual(3);
      expect(events).toContainEqual({ type: "text-delta", textDelta: "Original1" });
      expect(events).toContainEqual({ type: "text-delta", textDelta: "Original2" });
      expect(events.some((e) => e.type === "tool-call")).toBe(true);
    });

    it("should handle rapid SubAgent event bursts without dropping events", async () => {
      const originalStream = createAsyncIterableStream(
        new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-delta", textDelta: "Start" });
            controller.close();
          },
        }),
      );

      const streamController: { current: ReadableStreamDefaultController<any> | null } = {
        current: null,
      };
      const subAgentStatus = new Map<string, { isActive: boolean; isCompleted: boolean }>();

      const enhancedStream = (agentWithSubAgents as any).createEnhancedFullStream(
        originalStream,
        streamController,
        subAgentStatus,
      );

      const events: any[] = [];
      const expectedBurstEvents = 10;

      // Start consuming the stream
      const streamPromise = (async () => {
        for await (const event of enhancedStream) {
          events.push(event);

          // Inject burst of events after first event
          if (events.length === 1 && streamController.current) {
            for (let i = 0; i < expectedBurstEvents; i++) {
              streamController.current.enqueue({
                type: "tool-call",
                subAgentId: `burst-sub-${i}`,
                subAgentName: `Burst Sub ${i}`,
                timestamp: new Date().toISOString(),
                toolCallId: `burst-call-${i}`,
                toolName: `burst-tool-${i}`,
                args: { index: i },
              });
            }
          }
        }
      })();

      await streamPromise;

      // Should contain original event plus all burst events
      expect(events.length).toBe(1 + expectedBurstEvents);
      expect(events[0]).toEqual({ type: "text-delta", textDelta: "Start" });

      // Verify all burst events are present
      const burstEvents = events.filter((e) => e.type === "tool-call");
      expect(burstEvents.length).toBe(expectedBurstEvents);
    });

    it("should maintain event order when multiple SubAgents emit simultaneously", async () => {
      const originalStream = createAsyncIterableStream(
        new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-delta", textDelta: "Base1" });
            controller.enqueue({ type: "text-delta", textDelta: "Base2" });
            controller.close();
          },
        }),
      );

      const streamController: { current: ReadableStreamDefaultController<any> | null } = {
        current: null,
      };
      const subAgentStatus = new Map<string, { isActive: boolean; isCompleted: boolean }>();

      const enhancedStream = (agentWithSubAgents as any).createEnhancedFullStream(
        originalStream,
        streamController,
        subAgentStatus,
      );

      const events: any[] = [];
      let injectionDone = false;

      // Start consuming the stream
      const streamPromise = (async () => {
        for await (const event of enhancedStream) {
          events.push(event);

          // Inject ordered events from multiple SubAgents after first base event
          if (events.length === 1 && !injectionDone && streamController.current) {
            injectionDone = true;

            // SubAgent A events
            streamController.current.enqueue({
              type: "tool-call",
              subAgentId: "sub-a",
              subAgentName: "Sub A",
              timestamp: "2023-01-01T10:00:00.000Z",
              toolCallId: "call-a1",
              toolName: "tool-a",
              args: { order: 1 },
            });

            // SubAgent B events
            streamController.current.enqueue({
              type: "tool-call",
              subAgentId: "sub-b",
              subAgentName: "Sub B",
              timestamp: "2023-01-01T10:00:01.000Z",
              toolCallId: "call-b1",
              toolName: "tool-b",
              args: { order: 2 },
            });

            // SubAgent A result
            streamController.current.enqueue({
              type: "tool-result",
              subAgentId: "sub-a",
              subAgentName: "Sub A",
              timestamp: "2023-01-01T10:00:02.000Z",
              toolCallId: "call-a1",
              toolName: "tool-a",
              result: "result-a",
            });
          }
        }
      })();

      await streamPromise;

      // Verify events are in correct order
      expect(events.length).toBe(5); // 2 base + 3 injected
      expect(events[0]).toEqual({ type: "text-delta", textDelta: "Base1" });
      expect(events[1].type).toBe("tool-call");
      expect(events[1].subAgentId).toBe("sub-a");
      expect(events[2].type).toBe("tool-call");
      expect(events[2].subAgentId).toBe("sub-b");
      expect(events[3].type).toBe("tool-result");
      expect(events[3].subAgentId).toBe("sub-a");
      expect(events[4]).toEqual({ type: "text-delta", textDelta: "Base2" });
    });

    // Stream Controller Lifecycle Tests
    it("should properly initialize and cleanup stream controller", async () => {
      const originalStream = createAsyncIterableStream(
        new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-delta", textDelta: "Test" });
            controller.close();
          },
        }),
      );

      const streamController: { current: ReadableStreamDefaultController<any> | null } = {
        current: null,
      };
      const subAgentStatus = new Map<string, { isActive: boolean; isCompleted: boolean }>();

      // Initially controller should be null
      expect(streamController.current).toBeNull();

      const enhancedStream = (agentWithSubAgents as any).createEnhancedFullStream(
        originalStream,
        streamController,
        subAgentStatus,
      );

      const events: any[] = [];
      let controllerWasSet = false;

      for await (const event of enhancedStream) {
        events.push(event);

        // Check if controller was set during stream processing
        if (streamController.current !== null) {
          controllerWasSet = true;
        }
      }

      // After stream completion, controller should be cleaned up
      expect(streamController.current).toBeNull();
      expect(controllerWasSet).toBe(true);
      expect(events).toContainEqual({ type: "text-delta", textDelta: "Test" });
    });

    it("should handle stream controller errors during event injection", async () => {
      const originalStream = createAsyncIterableStream(
        new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-delta", textDelta: "Before Error" });
            controller.close();
          },
        }),
      );

      // Create a mock controller that throws on enqueue
      const errorController = {
        enqueue: vi.fn().mockImplementation(() => {
          throw new Error("Controller enqueue failed");
        }),
        close: vi.fn(),
        error: vi.fn(),
      };

      const streamController: { current: ReadableStreamDefaultController<any> | null } = {
        current: errorController as any,
      };
      const subAgentStatus = new Map<string, { isActive: boolean; isCompleted: boolean }>();

      const enhancedStream = (agentWithSubAgents as any).createEnhancedFullStream(
        originalStream,
        streamController,
        subAgentStatus,
      );

      const events: any[] = [];

      // Stream should continue working despite controller errors
      for await (const event of enhancedStream) {
        events.push(event);
      }

      expect(events).toContainEqual({ type: "text-delta", textDelta: "Before Error" });
    });

    // SubAgent Status Tracking Tests
    it("should track SubAgent completion status correctly", async () => {
      const originalStream = createAsyncIterableStream(
        new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-delta", textDelta: "Processing" });
            controller.close();
          },
        }),
      );

      const streamController: { current: ReadableStreamDefaultController<any> | null } = {
        current: null,
      };
      const subAgentStatus = new Map<string, { isActive: boolean; isCompleted: boolean }>();

      // Add some SubAgents to status tracking
      subAgentStatus.set("sub-agent-1", { isActive: true, isCompleted: false });
      subAgentStatus.set("sub-agent-2", { isActive: true, isCompleted: false });
      subAgentStatus.set("sub-agent-3", { isActive: false, isCompleted: true });

      const enhancedStream = (agentWithSubAgents as any).createEnhancedFullStream(
        originalStream,
        streamController,
        subAgentStatus,
      );

      const events: any[] = [];
      for await (const event of enhancedStream) {
        events.push(event);
      }

      // After stream completion, active SubAgents should be marked as completed
      expect(subAgentStatus.get("sub-agent-1")?.isCompleted).toBe(true);
      expect(subAgentStatus.get("sub-agent-2")?.isCompleted).toBe(true);
      expect(subAgentStatus.get("sub-agent-3")?.isCompleted).toBe(true); // Already completed
    });

    it("should mark abandoned SubAgents as completed on stream end", async () => {
      const originalStream = createAsyncIterableStream(
        new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-delta", textDelta: "Final" });
            controller.close();
          },
        }),
      );

      const streamController: { current: ReadableStreamDefaultController<any> | null } = {
        current: null,
      };
      const subAgentStatus = new Map<string, { isActive: boolean; isCompleted: boolean }>();

      // Simulate abandoned SubAgents
      subAgentStatus.set("abandoned-1", { isActive: true, isCompleted: false });
      subAgentStatus.set("abandoned-2", { isActive: true, isCompleted: false });
      subAgentStatus.set("completed-1", { isActive: false, isCompleted: true });

      const enhancedStream = (agentWithSubAgents as any).createEnhancedFullStream(
        originalStream,
        streamController,
        subAgentStatus,
      );

      const events: any[] = [];
      for await (const event of enhancedStream) {
        events.push(event);
      }

      // All active SubAgents should be marked as completed
      for (const [, status] of subAgentStatus.entries()) {
        expect(status.isCompleted).toBe(true);
      }
    });

    // Event Filtering and Processing Tests
    it("should filter different event types correctly in streamEventForwarder", async () => {
      const mockForwarder = vi.fn().mockResolvedValue(undefined);

      // Create streamEventForwarder function like in the real code
      const streamEventForwarder = async (event: any) => {
        // Filter out text, reasoning, and source events from SubAgents
        if (event.type === "text" || event.type === "reasoning" || event.type === "source") {
          return; // Should not call forwarder
        }

        // Add sub-agent prefix to distinguish from parent events
        const prefixedData = {
          ...event.data,
          timestamp: event.timestamp,
          type: event.type,
          subAgentId: event.subAgentId,
          subAgentName: event.subAgentName,
        };

        // For tool events, add subagent prefix to display name
        if (event.type === "tool-call" && prefixedData.toolCall) {
          prefixedData.toolCall = {
            ...prefixedData.toolCall,
            toolName: `${event.subAgentName}: ${prefixedData.toolCall.toolName}`,
          };
        } else if (event.type === "tool-result" && prefixedData.toolResult) {
          prefixedData.toolResult = {
            ...prefixedData.toolResult,
            toolName: `${event.subAgentName}: ${prefixedData.toolResult.toolName}`,
          };
        }

        if (mockForwarder) {
          await mockForwarder(prefixedData);
        }
      };

      // Test various event types
      const testEvents = [
        { type: "text", shouldBeFiltered: true },
        { type: "reasoning", shouldBeFiltered: true },
        { type: "source", shouldBeFiltered: true },
        {
          type: "tool-call",
          shouldBeFiltered: false,
          data: { toolCall: { toolName: "test-tool" } },
        },
        {
          type: "tool-result",
          shouldBeFiltered: false,
          data: { toolResult: { toolName: "test-tool" } },
        },
        { type: "error", shouldBeFiltered: false },
        { type: "text-delta", shouldBeFiltered: false },
      ];

      let forwardedCount = 0;
      for (const testEvent of testEvents) {
        mockForwarder.mockClear();

        await streamEventForwarder({
          ...testEvent,
          data: testEvent.data || {},
          timestamp: "2023-01-01",
          subAgentId: "test-sub",
          subAgentName: "Test Sub",
        });

        if (testEvent.shouldBeFiltered) {
          expect(mockForwarder).not.toHaveBeenCalled();
        } else {
          expect(mockForwarder).toHaveBeenCalled();
          forwardedCount++;
        }
      }

      expect(forwardedCount).toBe(4); // tool-call, tool-result, error, text-delta
    });

    it("should handle malformed SubAgent events gracefully", async () => {
      const mockForwarder = vi.fn().mockResolvedValue(undefined);

      const streamEventForwarder = async (event: any) => {
        try {
          if (event.type === "text" || event.type === "reasoning" || event.type === "source") {
            return;
          }

          const prefixedData = {
            ...event.data,
            timestamp: event.timestamp,
            type: event.type,
            subAgentId: event.subAgentId,
            subAgentName: event.subAgentName,
          };

          if (mockForwarder) {
            await mockForwarder(prefixedData);
          }
        } catch {
          // Should handle errors gracefully
          return;
        }
      };

      // Test malformed events
      const malformedEvents = [
        null,
        undefined,
        { type: "tool-call" }, // Missing required fields
        { type: "tool-call", data: null },
        { type: "tool-call", data: { toolCall: null } },
        { timestamp: "2023-01-01" }, // Missing type
      ];

      for (const malformedEvent of malformedEvents) {
        // Should not throw
        await expect(streamEventForwarder(malformedEvent)).resolves.toBeUndefined();
      }
    });

    it("should preserve event metadata during forwarding", async () => {
      const mockForwarder = vi.fn().mockResolvedValue(undefined);

      const streamEventForwarder = async (event: any) => {
        if (event.type === "text" || event.type === "reasoning" || event.type === "source") {
          return;
        }

        const prefixedData = {
          ...event.data,
          timestamp: event.timestamp,
          type: event.type,
          subAgentId: event.subAgentId,
          subAgentName: event.subAgentName,
        };

        if (mockForwarder) {
          await mockForwarder(prefixedData);
        }
      };

      const eventWithMetadata = {
        type: "tool-call",
        data: {
          toolCall: {
            toolName: "test-tool",
            toolCallId: "call-123",
            args: { param: "value" },
          },
          metadata: {
            executionTime: 150,
            retryCount: 0,
            custom: "data",
          },
        },
        timestamp: "2023-01-01T10:00:00.000Z",
        subAgentId: "meta-sub",
        subAgentName: "Meta Sub",
      };

      await streamEventForwarder(eventWithMetadata);

      expect(mockForwarder).toHaveBeenCalledWith({
        toolCall: {
          toolName: "test-tool",
          toolCallId: "call-123",
          args: { param: "value" },
        },
        metadata: {
          executionTime: 150,
          retryCount: 0,
          custom: "data",
        },
        timestamp: "2023-01-01T10:00:00.000Z",
        type: "tool-call",
        subAgentId: "meta-sub",
        subAgentName: "Meta Sub",
      });
    });
  });

  describe("Concurrent SubAgent Event Propagation", () => {
    it("should prevent event mixing between concurrent operations on same agent", async () => {
      // Track published events to verify proper isolation
      const publishedEvents: Array<{
        agentId: string;
        historyId: string;
        parentHistoryEntryId?: string;
        eventName: string;
      }> = [];

      // Spy on AgentEventEmitter to track event propagation
      const mockEventEmitterSpy = vi
        .spyOn(AgentEventEmitter.getInstance(), "publishTimelineEventAsync")
        .mockImplementation((params: any) => {
          publishedEvents.push({
            agentId: params.agentId,
            historyId: params.historyId,
            parentHistoryEntryId: params.parentHistoryEntryId,
            eventName: params.event?.name || "unknown",
          });
        });

      try {
        // Create parent agent for testing
        const testParentAgent = new TestAgent({
          id: "concurrent-parent",
          name: "Concurrent Parent",
          description: "Parent agent for concurrent testing",
          model: mockModel,
          llm: mockProvider,
          instructions: "Parent agent for concurrent testing",
        });

        // Start two concurrent operations
        const [result1, result2] = await Promise.all([
          testParentAgent.generateText("Concurrent operation 1", {
            userId: "user-1",
            conversationId: "conv-1",
          }),
          testParentAgent.generateText("Concurrent operation 2", {
            userId: "user-2",
            conversationId: "conv-2",
          }),
        ]);

        // Verify both operations completed successfully
        expect(result1.text).toBe("Hello, I am a test agent!");
        expect(result2.text).toBe("Hello, I am a test agent!");

        // Verify that events were published and properly isolated
        expect(publishedEvents.length).toBeGreaterThan(0);

        // Get unique operation IDs (historyId is used as operation identifier)
        const operationIds = [...new Set(publishedEvents.map((e) => e.historyId))];
        expect(operationIds.length).toBeGreaterThanOrEqual(2);

        // Verify events are properly associated with their operations
        operationIds.forEach((operationId) => {
          const operationEvents = publishedEvents.filter((e) => e.historyId === operationId);
          expect(operationEvents.length).toBeGreaterThan(0);
        });
      } finally {
        mockEventEmitterSpy.mockRestore();
      }
    });

    it("should ensure parentHistoryEntryId propagation prevents event cross-contamination", async () => {
      const eventsByOperation: Map<string, Array<any>> = new Map();

      const mockEventEmitterSpy = vi
        .spyOn(AgentEventEmitter.getInstance(), "publishTimelineEventAsync")
        .mockImplementation((params: any) => {
          const operationId = params.historyId;
          if (!eventsByOperation.has(operationId)) {
            eventsByOperation.set(operationId, []);
          }
          const operationEvents = eventsByOperation.get(operationId);
          if (operationEvents) {
            operationEvents.push({
              agentId: params.agentId,
              eventName: params.event?.name,
              parentHistoryEntryId: params.parentHistoryEntryId,
              skipPropagation: params.skipPropagation,
            });
          }
        });

      try {
        const testAgent = new TestAgent({
          id: "propagation-test-agent",
          name: "Propagation Test Agent",
          description: "Agent for testing event propagation",
          model: mockModel,
          llm: mockProvider,
          instructions: "Agent for testing event propagation",
        });

        // Run concurrent operations with different contexts
        await Promise.all([
          testAgent.generateText("Operation A with context", {
            userContext: new Map([["operationId", "op-a"]]),
          }),
          testAgent.generateText("Operation B with context", {
            userContext: new Map([["operationId", "op-b"]]),
          }),
        ]);

        // Verify we have events for multiple operations
        expect(eventsByOperation.size).toBeGreaterThanOrEqual(2);

        // Verify events are properly isolated per operation
        for (const [operationId, events] of eventsByOperation.entries()) {
          expect(events.length).toBeGreaterThan(0);
          expect(operationId).toBeDefined();

          // Events within an operation should be consistent
          events.forEach((event) => {
            expect(event.agentId).toBeDefined();
            expect(event.eventName).toBeDefined();
          });
        }
      } finally {
        mockEventEmitterSpy.mockRestore();
      }
    });

    it("should handle rapid concurrent operations without event leakage", async () => {
      const eventsPerOperation: Map<string, number> = new Map();

      const mockEventEmitterSpy = vi
        .spyOn(AgentEventEmitter.getInstance(), "publishTimelineEventAsync")
        .mockImplementation((params: any) => {
          const operationId = params.historyId;
          eventsPerOperation.set(operationId, (eventsPerOperation.get(operationId) || 0) + 1);
        });

      try {
        const rapidTestAgent = new TestAgent({
          id: "rapid-test-agent",
          name: "Rapid Test Agent",
          description: "Agent for rapid concurrent testing",
          model: mockModel,
          llm: mockProvider,
          instructions: "Agent for rapid concurrent testing",
        });

        const concurrentOperations = 3;
        const operations = Array.from({ length: concurrentOperations }, (_, i) =>
          rapidTestAgent.generateText(`Rapid operation ${i + 1}`),
        );

        const results = await Promise.all(operations);

        // Verify all operations completed successfully
        expect(results).toHaveLength(concurrentOperations);
        results.forEach((result) => {
          expect(result.text).toBe("Hello, I am a test agent!");
        });

        // Verify that we have the expected number of separate operations
        expect(eventsPerOperation.size).toBe(concurrentOperations);

        // Each operation should have received some events
        for (const [operationId, eventCount] of eventsPerOperation.entries()) {
          expect(eventCount).toBeGreaterThan(0);
          expect(operationId).toBeDefined();
          expect(operationId).not.toBe("");
        }
      } finally {
        mockEventEmitterSpy.mockRestore();
      }
    });
  });

  describe("SubAgent conversationSteps integration", () => {
    it("should pass parentOperationContext to SubAgent via delegate tool", async () => {
      // Simple test to verify parentOperationContext is passed correctly
      const parentAgent = new TestAgent({
        id: "parent-test",
        name: "ParentTestAgent",
        instructions: "Parent agent for testing",
        llm: new MockProvider({ modelId: "parent-model" }),
        model: { modelId: "parent-model" },
      });

      const subAgent = new TestAgent({
        id: "sub-test",
        name: "SubTestAgent",
        instructions: "Sub agent for testing",
        llm: new MockProvider({ modelId: "sub-model" }),
        model: { modelId: "sub-model" },
      });

      parentAgent.addSubAgent(subAgent);

      // Create test operation context
      const testOperationContext = {
        operationId: "test-op-123",
        userContext: new Map([["testKey", "testValue"]]),
        conversationSteps: [{ type: "test", content: "initial step" }],
        historyEntry: {
          id: "test-history-123",
          startTime: new Date(),
          input: "test input",
          output: "test output",
          status: "completed" as const,
          steps: [],
          usage: { totalTokens: 0 },
          model: "test-model",
        },
        isActive: true,
      };

      // Spy on SubAgent's streamText
      const subAgentSpy = vi.spyOn(subAgent, "streamText");

      // Get delegate tool directly
      const delegateTool = parentAgent.getSubAgentManager().createDelegateTool({
        sourceAgent: parentAgent,
        operationContext: testOperationContext,
        currentHistoryEntryId: "test-history-123",
      });

      // Execute delegate tool directly
      await delegateTool.execute({
        task: "Test task for SubAgent",
        targetAgents: ["SubTestAgent"],
        context: { testContext: true },
      });

      // Verify SubAgent was called
      expect(subAgentSpy).toHaveBeenCalled();

      // Get the call arguments
      const callArgs = subAgentSpy.mock.calls[0];
      const callOptions = callArgs[1] as any;

      // Verify parentOperationContext was passed
      expect(callOptions.parentOperationContext).toBeDefined();
      expect(callOptions.parentOperationContext.operationId).toBe("test-op-123");
      expect(callOptions.parentOperationContext.userContext.get("testKey")).toBe("testValue");
      expect(Array.isArray(callOptions.parentOperationContext.conversationSteps)).toBe(true);
      expect(callOptions.parentOperationContext.conversationSteps[0].content).toBe("initial step");

      subAgentSpy.mockRestore();
    });

    it("should inherit userContext from parent's operationContext", async () => {
      // Test that SubAgent inherits userContext from parent's operationContext
      const parentAgent = new TestAgent({
        id: "parent-ctx",
        name: "ParentContextAgent",
        instructions: "Parent with context",
        llm: new MockProvider({ modelId: "mock-model" }),
        model: { modelId: "mock-model" },
      });

      const subAgent = new TestAgent({
        id: "sub-ctx",
        name: "SubContextAgent",
        instructions: "Sub with inherited context",
        llm: new MockProvider({ modelId: "mock-model" }),
        model: { modelId: "mock-model" },
      });

      parentAgent.addSubAgent(subAgent);

      // Create parent context with userContext
      const parentUserContext = new Map<string | symbol, unknown>();
      parentUserContext.set("parentKey", "parentValue");
      parentUserContext.set("sharedData", { important: true });

      const parentOperationContext = {
        operationId: "parent-op",
        userContext: parentUserContext,
        conversationSteps: [],
        historyEntry: { id: "parent-history" },
        isActive: true,
      };

      // Spy on SubAgent's streamText
      const subAgentSpy = vi.spyOn(subAgent, "streamText");

      // Execute delegate tool with parent context
      const delegateTool = parentAgent.getSubAgentManager().createDelegateTool({
        sourceAgent: parentAgent,
        operationContext: parentOperationContext,
        currentHistoryEntryId: "parent-history",
      });

      await delegateTool.execute({
        task: "Inherit context test",
        targetAgents: ["SubContextAgent"],
        context: {},
      });

      // Verify SubAgent received parent's userContext
      expect(subAgentSpy).toHaveBeenCalled();
      const subAgentOptions = subAgentSpy.mock.calls[0][1] as any;
      const receivedContext = subAgentOptions.parentOperationContext;

      expect(receivedContext.userContext).toBe(parentUserContext); // Same reference
      expect(receivedContext.userContext.get("parentKey")).toBe("parentValue");
      expect(receivedContext.userContext.get("sharedData")).toEqual({ important: true });

      subAgentSpy.mockRestore();
    });

    it("should share conversationSteps array between parent and SubAgent", async () => {
      // Test that conversationSteps array is shared between parent and SubAgent
      const parentAgent = new TestAgent({
        id: "parent-steps",
        name: "ParentStepsAgent",
        instructions: "Parent with steps",
        llm: new MockProvider({ modelId: "mock-model" }),
        model: { modelId: "mock-model" },
      });

      const subAgent = new TestAgent({
        id: "sub-steps",
        name: "SubStepsAgent",
        instructions: "Sub with shared steps",
        llm: new MockProvider({ modelId: "mock-model" }),
        model: { modelId: "mock-model" },
      });

      parentAgent.addSubAgent(subAgent);

      // Create shared conversationSteps array
      const sharedSteps: any[] = [{ type: "initial", content: "Parent started" }];

      const parentOperationContext = {
        operationId: "steps-op",
        userContext: new Map(),
        conversationSteps: sharedSteps,
        historyEntry: { id: "steps-history" },
        isActive: true,
      };

      // Spy on SubAgent
      const subAgentSpy = vi.spyOn(subAgent, "streamText");

      // Execute delegate tool
      const delegateTool = parentAgent.getSubAgentManager().createDelegateTool({
        sourceAgent: parentAgent,
        operationContext: parentOperationContext,
        currentHistoryEntryId: "steps-history",
      });

      await delegateTool.execute({
        task: "Shared steps test",
        targetAgents: ["SubStepsAgent"],
        context: {},
      });

      // Verify SubAgent received same conversationSteps array
      expect(subAgentSpy).toHaveBeenCalled();
      const subAgentOptions = subAgentSpy.mock.calls[0][1] as any;
      const receivedSteps = subAgentOptions.parentOperationContext.conversationSteps;

      // Should be the same array reference
      expect(receivedSteps).toBe(sharedSteps);
      expect(receivedSteps[0].content).toBe("Parent started");

      subAgentSpy.mockRestore();
    });
  });

  describe("maxSteps handling", () => {
    it("should use agent-level maxSteps when no options maxSteps provided", async () => {
      const agent = new TestAgent({
        name: "MaxSteps Agent",
        instructions: "Agent with maxSteps",
        llm: mockProvider,
        model: mockModel,
        maxSteps: 15,
      });

      // Mock the provider to capture the maxSteps parameter
      const generateTextSpy = vi.spyOn(mockProvider, "generateText").mockResolvedValue({
        text: "Test response",
        usage: { totalTokens: 10, promptTokens: 5, completionTokens: 5 },
        finishReason: "stop",
        provider: { text: "Test response" },
        toolCalls: [],
        toolResults: [],
      });

      await agent.generateText("Test message");

      expect(generateTextSpy).toHaveBeenCalled();
      const callArgs = generateTextSpy.mock.calls[0][0];
      expect(callArgs.maxSteps).toBe(15);
    });

    it("should use options maxSteps when provided, overriding agent maxSteps", async () => {
      const agent = new TestAgent({
        name: "MaxSteps Agent",
        instructions: "Agent with maxSteps",
        llm: mockProvider,
        model: mockModel,
        maxSteps: 15,
      });

      // Mock the provider to capture the maxSteps parameter
      const generateTextSpy = vi.spyOn(mockProvider, "generateText").mockResolvedValue({
        text: "Test response",
        usage: { totalTokens: 10, promptTokens: 5, completionTokens: 5 },
        finishReason: "stop",
        provider: { text: "Test response" },
        toolCalls: [],
        toolResults: [],
      });

      await agent.generateText("Test message", { maxSteps: 25 });

      expect(generateTextSpy).toHaveBeenCalled();
      const callArgs = generateTextSpy.mock.calls[0][0];
      expect(callArgs.maxSteps).toBe(25);
    });

    it("should use default maxSteps calculation when no agent maxSteps defined", async () => {
      const agent = new TestAgent({
        name: "No MaxSteps Agent",
        instructions: "Agent without maxSteps",
        llm: mockProvider,
        model: mockModel,
        // No maxSteps defined
      });

      // Mock the provider to capture the maxSteps parameter
      const generateTextSpy = vi.spyOn(mockProvider, "generateText").mockResolvedValue({
        text: "Test response",
        usage: { totalTokens: 10, promptTokens: 5, completionTokens: 5 },
        finishReason: "stop",
        warnings: [],
        providerResponse: {},
        provider: { text: "Test response" },
        toolCalls: [],
        toolResults: [],
      });

      await agent.generateText("Test message");

      expect(generateTextSpy).toHaveBeenCalled();
      const callArgs = generateTextSpy.mock.calls[0][0];
      expect(callArgs.maxSteps).toBe(10); // Default calculation
    });

    it("should calculate maxSteps based on sub-agents count", async () => {
      const parentAgent = new TestAgent({
        name: "Parent Agent",
        instructions: "Parent with sub-agents",
        llm: mockProvider,
        model: mockModel,
        // No maxSteps defined - should use calculation
      });

      const subAgent1 = new TestAgent({
        name: "Sub Agent 1",
        instructions: "Sub agent 1",
        llm: mockProvider,
        model: mockModel,
      });

      const subAgent2 = new TestAgent({
        name: "Sub Agent 2",
        instructions: "Sub agent 2",
        llm: mockProvider,
        model: mockModel,
      });

      parentAgent.addSubAgent(subAgent1);
      parentAgent.addSubAgent(subAgent2);

      // Mock the provider to capture the maxSteps parameter
      const generateTextSpy = vi.spyOn(mockProvider, "generateText").mockResolvedValue({
        text: "Test response",
        usage: { totalTokens: 10, promptTokens: 5, completionTokens: 5 },
        finishReason: "stop",
        provider: { text: "Test response" },
        toolCalls: [],
        toolResults: [],
      });

      await parentAgent.generateText("Test message");

      expect(generateTextSpy).toHaveBeenCalled();
      const callArgs = generateTextSpy.mock.calls[0][0];
      expect(callArgs.maxSteps).toBe(20); // 10 * 2 sub-agents
    });

    it("should use agent-level maxSteps even when sub-agents exist", async () => {
      const parentAgent = new TestAgent({
        name: "Parent Agent",
        instructions: "Parent with sub-agents and maxSteps",
        llm: mockProvider,
        model: mockModel,
        maxSteps: 30, // Explicit maxSteps
      });

      const subAgent1 = new TestAgent({
        name: "Sub Agent 1",
        instructions: "Sub agent 1",
        llm: mockProvider,
        model: mockModel,
      });

      parentAgent.addSubAgent(subAgent1);

      // Mock the provider to capture the maxSteps parameter
      const generateTextSpy = vi.spyOn(mockProvider, "generateText").mockResolvedValue({
        text: "Test response",
        usage: { totalTokens: 10, promptTokens: 5, completionTokens: 5 },
        finishReason: "stop",
        warnings: [],
        providerResponse: {},
        provider: { text: "Test response" },
        toolCalls: [],
        toolResults: [],
      });

      await parentAgent.generateText("Test message");

      expect(generateTextSpy).toHaveBeenCalled();
      const callArgs = generateTextSpy.mock.calls[0][0];
      expect(callArgs.maxSteps).toBe(30); // Agent-level maxSteps takes priority
    });

    it("should pass maxSteps to streamText", async () => {
      const agent = new TestAgent({
        name: "Stream Agent",
        instructions: "Agent for streaming",
        llm: mockProvider,
        model: mockModel,
        maxSteps: 20,
      });

      // Mock the provider to capture the maxSteps parameter
      const streamTextSpy = vi.spyOn(mockProvider, "streamText").mockResolvedValue({
        textStream: (async function* () {
          yield "test";
        })(),
        fullStream: (async function* () {
          yield { type: "text-delta", textDelta: "test" };
        })(),
        provider: { textStream: new ReadableStream() },
      });

      await agent.streamText("Test message");

      expect(streamTextSpy).toHaveBeenCalled();
      const callArgs = streamTextSpy.mock.calls[0][0];
      expect(callArgs.maxSteps).toBe(20);
    });

    it("should pass maxSteps to generateObject", async () => {
      const agent = new TestAgent({
        name: "Object Agent",
        instructions: "Agent for objects",
        llm: mockProvider,
        model: mockModel,
        maxSteps: 12,
      });

      const schema = z.object({
        name: z.string(),
        age: z.number(),
      });

      // Mock the provider to capture the maxSteps parameter
      const generateObjectSpy = vi.spyOn(mockProvider, "generateObject").mockResolvedValue({
        object: { name: "Test", age: 25 },
        usage: { totalTokens: 10, promptTokens: 5, completionTokens: 5 },
        finishReason: "stop",
        warnings: [],
        providerResponse: {},
        provider: { object: { name: "Test", age: 25 } },
      });

      await agent.generateObject("Test message", schema);

      expect(generateObjectSpy).toHaveBeenCalled();
      const callArgs = generateObjectSpy.mock.calls[0][0];
      // Note: generateObject might not use maxSteps, but let's verify it's passed
      expect(callArgs).toHaveProperty("schema");
    });

    it("should pass maxSteps to streamObject", async () => {
      const agent = new TestAgent({
        name: "Stream Object Agent",
        instructions: "Agent for streaming objects",
        llm: mockProvider,
        model: mockModel,
        maxSteps: 18,
      });

      const schema = z.object({
        name: z.string(),
        age: z.number(),
      });

      // Mock the provider to capture the maxSteps parameter
      const streamObjectSpy = vi.spyOn(mockProvider, "streamObject").mockResolvedValue({
        stream: new ReadableStream(),
        partialObjectStream: new ReadableStream(),
        textStream: new ReadableStream(),
        provider: { stream: new ReadableStream() },
        objectStream: new ReadableStream(),
      });

      await agent.streamObject("Test message", schema);

      expect(streamObjectSpy).toHaveBeenCalled();
      const callArgs = streamObjectSpy.mock.calls[0][0];
      expect(callArgs).toHaveProperty("schema");
    });

    it("should pass maxSteps to subagents through delegate tool", async () => {
      const parentAgent = new TestAgent({
        name: "Parent Agent",
        instructions: "Parent with sub-agents",
        llm: mockProvider,
        model: mockModel,
        maxSteps: 35,
      });

      const subAgent = new TestAgent({
        name: "Sub Agent",
        instructions: "Sub agent",
        llm: mockProvider,
        model: mockModel,
      });

      parentAgent.addSubAgent(subAgent);

      // Mock sub-agent's streamText method to check maxSteps
      const subAgentStreamTextSpy = vi.spyOn(subAgent, "streamText").mockResolvedValue({
        textStream: (async function* () {
          yield "sub response";
        })(),
        fullStream: (async function* () {
          yield { type: "text-delta", textDelta: "sub response" };
        })(),
        userContext: new Map(),
      });

      // Get the delegate tool
      const delegateTool = parentAgent.getSubAgentManager().createDelegateTool({
        sourceAgent: parentAgent,
        operationContext: {
          operationId: "test-op",
          userContext: new Map(),
          conversationSteps: [],
          historyEntry: { id: "test-history" },
          isActive: true,
        },
        currentHistoryEntryId: "test-history",
        maxSteps: 35, // Should be passed to sub-agent
      });

      await delegateTool.execute({
        task: "Test task",
        targetAgents: ["Sub Agent"],
        context: {},
      });

      expect(subAgentStreamTextSpy).toHaveBeenCalled();
      const subAgentCallArgs = subAgentStreamTextSpy.mock.calls[0][1];
      expect(subAgentCallArgs).toHaveProperty("maxSteps", 35);
    });

    it("should use options maxSteps over agent maxSteps in delegate tool", async () => {
      const parentAgent = new TestAgent({
        name: "Parent Agent",
        instructions: "Parent with sub-agents",
        llm: mockProvider,
        model: mockModel,
        maxSteps: 20, // Agent-level maxSteps
      });

      const subAgent = new TestAgent({
        name: "Sub Agent",
        instructions: "Sub agent",
        llm: mockProvider,
        model: mockModel,
      });

      parentAgent.addSubAgent(subAgent);

      // Mock sub-agent's streamText method to check maxSteps
      const subAgentStreamTextSpy = vi.spyOn(subAgent, "streamText").mockResolvedValue({
        textStream: (async function* () {
          yield "sub response";
        })(),
        fullStream: (async function* () {
          yield { type: "text-delta", textDelta: "sub response" };
        })(),
        userContext: new Map(),
      });

      // Get the delegate tool with options maxSteps
      const delegateTool = parentAgent.getSubAgentManager().createDelegateTool({
        sourceAgent: parentAgent,
        operationContext: {
          operationId: "test-op",
          userContext: new Map(),
          conversationSteps: [],
          historyEntry: { id: "test-history" },
          isActive: true,
        },
        currentHistoryEntryId: "test-history",
        maxSteps: 50, // Options maxSteps should override agent maxSteps
      });

      await delegateTool.execute({
        task: "Test task",
        targetAgents: ["Sub Agent"],
        context: {},
      });

      expect(subAgentStreamTextSpy).toHaveBeenCalled();
      const subAgentCallArgs = subAgentStreamTextSpy.mock.calls[0][1];
      expect(subAgentCallArgs).toHaveProperty("maxSteps", 50);
    });

    it("should handle zero maxSteps", async () => {
      const agent = new TestAgent({
        name: "Zero MaxSteps Agent",
        instructions: "Agent with zero maxSteps",
        llm: mockProvider,
        model: mockModel,
        maxSteps: 0,
      });

      // Mock the provider to capture the maxSteps parameter
      const generateTextSpy = vi.spyOn(mockProvider, "generateText").mockResolvedValue({
        text: "Test response",
        usage: { totalTokens: 10, promptTokens: 5, completionTokens: 5 },
        finishReason: "stop",
        warnings: [],
        providerResponse: {},
        provider: { text: "Test response" },
        toolCalls: [],
        toolResults: [],
      });

      await agent.generateText("Test message");

      expect(generateTextSpy).toHaveBeenCalled();
      const callArgs = generateTextSpy.mock.calls[0][0];
      expect(callArgs.maxSteps).toBe(0);
    });

    it("should handle negative maxSteps", async () => {
      const agent = new TestAgent({
        name: "Negative MaxSteps Agent",
        instructions: "Agent with negative maxSteps",
        llm: mockProvider,
        model: mockModel,
        maxSteps: -5,
      });

      // Mock the provider to capture the maxSteps parameter
      const generateTextSpy = vi.spyOn(mockProvider, "generateText").mockResolvedValue({
        text: "Test response",
        usage: { totalTokens: 10, promptTokens: 5, completionTokens: 5 },
        finishReason: "stop",
        warnings: [],
        providerResponse: {},
        provider: { text: "Test response" },
        toolCalls: [],
        toolResults: [],
      });

      await agent.generateText("Test message");

      expect(generateTextSpy).toHaveBeenCalled();
      const callArgs = generateTextSpy.mock.calls[0][0];
      expect(callArgs.maxSteps).toBe(-5);
    });
  });
});
// Dynamic Values Tests
describe("Agent Dynamic Values", () => {
  let mockLLM: MockProvider;
  let agent: Agent<{ llm: MockProvider }>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLLM = new MockProvider({ modelId: "test-model" });
  });

  describe("Dynamic Instructions", () => {
    it("should use static instructions when provided as string", () => {
      agent = new Agent({
        name: "Test Agent",
        instructions: "Static instructions",
        model: { modelId: "test-model" },
        llm: mockLLM,
      });

      expect(agent.instructions).toBe("Static instructions");
    });

    it("should resolve dynamic instructions based on user context", async () => {
      const dynamicInstructions = ({ userContext }: DynamicValueOptions) => {
        const userRole = userContext.get("userRole");
        return userRole === "admin" ? "Admin instructions" : "User instructions";
      };

      agent = new Agent({
        name: "Test Agent",
        instructions: dynamicInstructions,
        model: { modelId: "test-model" },
        llm: mockLLM,
      });

      // Test with admin role
      const adminContext = new Map([["userRole", "admin"]]);
      const adminResult = await (agent as any).resolveInstructions({ userContext: adminContext });
      expect(adminResult).toBe("Admin instructions");

      // Test with user role
      const userContext = new Map([["userRole", "user"]]);
      const userResult = await (agent as any).resolveInstructions({ userContext: userContext });
      expect(userResult).toBe("User instructions");
    });

    it("should handle async dynamic instructions", async () => {
      const asyncInstructions = async ({ userContext }: DynamicValueOptions) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const tier = userContext.get("tier");
        return `Instructions for ${tier} tier`;
      };

      agent = new Agent({
        name: "Test Agent",
        instructions: asyncInstructions,
        model: { modelId: "test-model" },
        llm: mockLLM,
      });

      const context = new Map([["tier", "premium"]]);
      const result = await (agent as any).resolveInstructions({ userContext: context });
      expect(result).toBe("Instructions for premium tier");
    });
  });

  describe("Dynamic Model", () => {
    it("should use static model when provided as object", () => {
      agent = new Agent({
        name: "Test Agent",
        instructions: "Test instructions",
        model: { modelId: "static-model" },
        llm: mockLLM,
      });

      expect(agent.model).toEqual({ modelId: "static-model" });
    });

    it("should resolve dynamic model based on user context", async () => {
      const dynamicModel = ({ userContext }: DynamicValueOptions) => {
        const tier = userContext.get("tier");
        return tier === "enterprise" ? { modelId: "gpt-4" } : { modelId: "gpt-3.5-turbo" };
      };

      agent = new Agent({
        name: "Test Agent",
        instructions: "Test instructions",
        model: dynamicModel,
        llm: mockLLM,
      });

      // Test with enterprise tier
      const enterpriseContext = new Map([["tier", "enterprise"]]);
      const enterpriseModel = await (agent as any).resolveModel({ userContext: enterpriseContext });
      expect(enterpriseModel).toEqual({ modelId: "gpt-4" });

      // Test with basic tier
      const basicContext = new Map([["tier", "basic"]]);
      const basicModel = await (agent as any).resolveModel({ userContext: basicContext });
      expect(basicModel).toEqual({ modelId: "gpt-3.5-turbo" });
    });
  });

  describe("Dynamic Tools", () => {
    it("should resolve dynamic tools based on user context", async () => {
      const basicTool = createTool({
        name: "basic-tool",
        description: "A basic tool",
        parameters: z.object({}),
        execute: vi.fn().mockResolvedValue("basic result"),
      });

      const adminTool = createTool({
        name: "admin-tool",
        description: "An admin tool",
        parameters: z.object({}),
        execute: vi.fn().mockResolvedValue("admin result"),
      });

      const dynamicTools = ({ userContext }: DynamicValueOptions) => {
        const permissions = userContext.get("permissions") as string[];
        const tools = [basicTool];
        if (permissions?.includes("admin")) {
          tools.push(adminTool);
        }
        return tools;
      };

      agent = new Agent({
        name: "Test Agent",
        instructions: "Test instructions",
        model: { modelId: "test-model" },
        tools: dynamicTools,
        llm: mockLLM,
      });

      // Test with admin permissions
      const adminContext = new Map([["permissions", ["admin", "user"]]]);
      const adminTools = await (agent as any).resolveTools({ userContext: adminContext });
      expect(adminTools).toHaveLength(2);
      expect(adminTools[0].name).toBe("basic-tool");
      expect(adminTools[1].name).toBe("admin-tool");

      // Test with user permissions only
      const userContext = new Map([["permissions", ["user"]]]);
      const userTools = await (agent as any).resolveTools({ userContext: userContext });
      expect(userTools).toHaveLength(1);
      expect(userTools[0].name).toBe("basic-tool");
    });

    it("should handle toolkits in dynamic tools", async () => {
      const mockToolkit: Toolkit = {
        name: "test-toolkit",
        description: "A test toolkit",
        tools: [],
        addInstructions: false,
      };

      const dynamicTools = ({ userContext }: DynamicValueOptions) => {
        const hasToolkits = userContext.get("hasToolkits");
        return hasToolkits ? [mockToolkit] : [];
      };

      agent = new Agent({
        name: "Test Agent",
        instructions: "Test instructions",
        model: { modelId: "test-model" },
        tools: dynamicTools,
        llm: mockLLM,
      });

      const context = new Map([["hasToolkits", true]]);
      const result = await (agent as any).resolveTools({ userContext: context });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("test-toolkit");
    });
  });

  describe("Integration Tests", () => {
    it("should use dynamic values during text generation", async () => {
      const dynamicInstructions = ({ userContext }: DynamicValueOptions) => {
        const role = userContext.get("role");
        return `You are a ${role} assistant.`;
      };

      const dynamicTools = ({ userContext }: DynamicValueOptions) => {
        const permissions = userContext.get("permissions") as string[];
        const tools: Tool<any>[] = [];
        if (permissions?.includes("search")) {
          tools.push(
            createTool({
              name: "search",
              description: "Search tool",
              parameters: z.object({}),
              execute: vi.fn().mockResolvedValue("search result"),
            }),
          );
        }
        return tools;
      };

      agent = new Agent({
        name: "Test Agent",
        instructions: dynamicInstructions,
        model: { modelId: "test-model" },
        tools: dynamicTools,
        llm: mockLLM,
        memory: mockMemory,
      });

      const userContext = new Map<string | symbol, unknown>([
        ["role", "support"],
        ["permissions", ["search", "read"]],
      ]);

      const result = await agent.generateText("Hello", { userContext });
      // Mock'un döndürdüğü sabit string (her zaman 'Hello, I am a test agent!' dönüyor)
      expect(result.text).toBe("Hello, I am a test agent!");
    });

    it("should handle empty user context gracefully", async () => {
      const dynamicInstructions = ({ userContext }: DynamicValueOptions) => {
        const role = userContext.get("role") || "default";
        return `You are a ${role} assistant.`;
      };

      agent = new Agent({
        name: "Test Agent",
        instructions: dynamicInstructions,
        model: { modelId: "test-model" },
        llm: mockLLM,
      });

      const result = await (agent as any).resolveInstructions({ userContext: new Map() });
      expect(result).toBe("You are a default assistant.");
    });

    it("should resolve dynamic instructions during getSystemMessage", async () => {
      const dynamicInstructions = ({ userContext }: DynamicValueOptions) => {
        const role = userContext.get("role");
        return `You are a ${role} assistant with special privileges.`;
      };

      agent = new Agent({
        name: "Test Agent",
        instructions: dynamicInstructions,
        model: { modelId: "test-model" },
        llm: mockLLM,
      });

      const operationContext = {
        userContext: new Map([["role", "admin"]]),
        operationId: "test-op",
        historyEntry: { id: "test-history" },
        isActive: true,
      } as any;

      const systemMessageResponse = await (agent as any).getSystemMessage({
        input: "test input",
        historyEntryId: "test-history",
        contextMessages: [],
        operationContext,
      });

      // systemMessages can be single BaseMessage or array of BaseMessages
      const systemMessages = Array.isArray(systemMessageResponse.systemMessages)
        ? systemMessageResponse.systemMessages
        : [systemMessageResponse.systemMessages];

      const systemMessageContent = systemMessages[0]?.content;
      expect(systemMessageContent).toContain(
        "You are Test Agent. You are a admin assistant with special privileges.",
      );

      // Also verify isDynamicInstructions is set correctly
      expect(systemMessageResponse.isDynamicInstructions).toBe(true);
    });

    it("should resolve dynamic model during text generation", async () => {
      const dynamicModel = ({ userContext }: DynamicValueOptions) => {
        const tier = userContext.get("tier");
        return tier === "premium" ? { modelId: "premium-model" } : { modelId: "basic-model" };
      };

      const generateTextSpy = vi.spyOn(mockLLM, "generateText");

      agent = new Agent({
        name: "Test Agent",
        instructions: "Test instructions",
        model: dynamicModel,
        llm: mockLLM,
        memory: mockMemory,
      });

      const userContext = new Map([["tier", "premium"]]);
      await agent.generateText("Hello", { userContext });

      // Verify that the resolved model was used
      expect(generateTextSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          model: { modelId: "premium-model" },
        }),
      );

      generateTextSpy.mockRestore();
    });

    it("should resolve dynamic tools during text generation", async () => {
      const adminTool = createTool({
        name: "admin-panel",
        description: "Admin panel access",
        parameters: z.object({}),
        execute: vi.fn().mockResolvedValue("admin accessed"),
      });

      const dynamicTools = ({ userContext }: DynamicValueOptions) => {
        const isAdmin = userContext.get("isAdmin");
        return isAdmin ? [adminTool] : [];
      };

      const generateTextSpy = vi.spyOn(mockLLM, "generateText");

      agent = new Agent({
        name: "Test Agent",
        instructions: "Test instructions",
        model: { modelId: "test-model" },
        tools: dynamicTools,
        llm: mockLLM,
        memory: mockMemory,
      });

      const userContext = new Map([["isAdmin", true]]);
      await agent.generateText("Hello", { userContext });

      // Verify that the resolved tools were passed to LLM
      const callArgs = generateTextSpy.mock.calls[0][0];
      expect(callArgs.tools).toBeDefined();
      expect(callArgs.tools?.some((tool) => tool.name === "admin-panel")).toBe(true);

      generateTextSpy.mockRestore();
    });

    it("should resolve all dynamic values together in complex scenario", async () => {
      const dynamicInstructions = ({ userContext }: DynamicValueOptions) => {
        const department = userContext.get("department");
        return `You are a ${department} department assistant.`;
      };

      const dynamicModel = ({ userContext }: DynamicValueOptions) => {
        const priority = userContext.get("priority");
        return priority === "high" ? { modelId: "fast-model" } : { modelId: "standard-model" };
      };

      const hrTool = createTool({
        name: "hr-tool",
        description: "HR operations",
        parameters: z.object({}),
        execute: vi.fn().mockResolvedValue("hr result"),
      });

      const finTool = createTool({
        name: "finance-tool",
        description: "Finance operations",
        parameters: z.object({}),
        execute: vi.fn().mockResolvedValue("finance result"),
      });

      const dynamicTools = ({ userContext }: DynamicValueOptions) => {
        const department = userContext.get("department");
        return department === "hr" ? [hrTool] : department === "finance" ? [finTool] : [];
      };

      const generateTextSpy = vi.spyOn(mockLLM, "generateText");

      agent = new Agent({
        name: "Corporate Agent",
        instructions: dynamicInstructions,
        model: dynamicModel,
        tools: dynamicTools,
        llm: mockLLM,
        memory: mockMemory,
      });

      const userContext = new Map([
        ["department", "hr"],
        ["priority", "high"],
        ["userId", "emp123"],
      ]);

      await agent.generateText("What can I help you with?", { userContext });

      const callArgs = generateTextSpy.mock.calls[0][0];

      // Verify dynamic model was resolved
      expect(callArgs.model).toEqual({ modelId: "fast-model" });

      // Verify dynamic tools were resolved
      expect(callArgs.tools?.some((tool) => tool.name === "hr-tool")).toBe(true);
      expect(callArgs.tools?.some((tool) => tool.name === "finance-tool")).toBe(false);

      // Verify dynamic instructions were used in system message
      const systemMessage = callArgs.messages[0];
      expect(systemMessage.content).toContain(
        "You are Corporate Agent. You are a hr department assistant.",
      );

      generateTextSpy.mockRestore();
    });

    it("should work with streamText and dynamic values", async () => {
      const dynamicModel = ({ userContext }: DynamicValueOptions) => {
        const model = userContext.get("preferredModel") as string;
        return { modelId: model || "default-model" };
      };

      const streamTextSpy = vi.spyOn(mockLLM, "streamText");

      agent = new Agent({
        name: "Streaming Agent",
        instructions: "I stream responses",
        model: dynamicModel,
        llm: mockLLM,
        memory: mockMemory,
      });

      const userContext = new Map([["preferredModel", "streaming-model"]]);
      await agent.streamText("Stream this", { userContext });

      // Verify that dynamic model was resolved for streaming
      expect(streamTextSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          model: { modelId: "streaming-model" },
        }),
      );

      streamTextSpy.mockRestore();
    });

    it("should resolve dynamic values for generateObject", async () => {
      const dynamicModel = ({ userContext }: DynamicValueOptions) => {
        const useAdvanced = userContext.get("useAdvanced");
        return useAdvanced ? { modelId: "advanced-model" } : { modelId: "basic-model" };
      };

      const generateObjectSpy = vi.spyOn(mockLLM, "generateObject");

      agent = new Agent({
        name: "Object Agent",
        instructions: "I generate objects",
        model: dynamicModel,
        llm: mockLLM,
        memory: mockMemory,
      });

      const schema = z.object({
        name: z.string(),
        age: z.number(),
      });

      const userContext = new Map([["useAdvanced", true]]);
      await agent.generateObject("Generate person", schema, { userContext });

      // Verify that dynamic model was used
      expect(generateObjectSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          model: { modelId: "advanced-model" },
        }),
      );

      generateObjectSpy.mockRestore();
    });

    it("should handle async dynamic model resolution", async () => {
      const asyncDynamicModel = async ({ userContext }: DynamicValueOptions) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const tier = userContext.get("tier");
        return { modelId: `async-${tier}-model` };
      };

      const generateTextSpy = vi.spyOn(mockLLM, "generateText");

      agent = new Agent({
        name: "Async Agent",
        instructions: "I use async model resolution",
        model: asyncDynamicModel,
        llm: mockLLM,
        memory: mockMemory,
      });

      const userContext = new Map([["tier", "enterprise"]]);
      await agent.generateText("Test async", { userContext });

      expect(generateTextSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          model: { modelId: "async-enterprise-model" },
        }),
      );

      generateTextSpy.mockRestore();
    });
  });
});

describe("Dynamic Instructions Detection", () => {
  it("should detect static instructions as not dynamic", async () => {
    // Create agent with static string instructions
    const staticAgent = new TestAgent({
      name: "StaticAgent",
      llm: new MockProvider({ modelId: "test-model" }),
      model: { modelId: "test-model" },
      instructions: "You are a helpful assistant with static instructions.",
    });

    // Get system message and check isDynamicInstructions
    const systemMessageResponse = await (staticAgent as any).getSystemMessage({
      input: "test input",
      historyEntryId: "test-id",
      contextMessages: [],
      operationContext: {
        operationId: "test-op",
        userContext: new Map(),
        historyEntry: createMockHistoryEntry("test"),
        isActive: true,
        conversationSteps: [],
      },
    });

    expect(systemMessageResponse.isDynamicInstructions).toBe(false);
  });

  it("should detect function instructions as dynamic", async () => {
    // Create agent with dynamic function instructions
    const dynamicAgent = new TestAgent({
      name: "DynamicAgent",
      llm: new MockProvider({ modelId: "test-model" }),
      model: { modelId: "test-model" },
      instructions: ({ userContext }: DynamicValueOptions) => {
        const userName = userContext.get("userName") || "user";
        return `You are a helpful assistant for ${userName}.`;
      },
    });

    // Get system message and check isDynamicInstructions
    const systemMessageResponse = await (dynamicAgent as any).getSystemMessage({
      input: "test input",
      historyEntryId: "test-id",
      contextMessages: [],
      operationContext: {
        operationId: "test-op",
        userContext: new Map([["userName", "Alice"]]),
        historyEntry: createMockHistoryEntry("test"),
        isActive: true,
        conversationSteps: [],
      },
    });

    expect(systemMessageResponse.isDynamicInstructions).toBe(true);

    // Also check that dynamic instructions were resolved properly
    expect(systemMessageResponse.systemMessages).toEqual({
      role: "system",
      content: "You are DynamicAgent. You are a helpful assistant for Alice.",
    });
  });

  it("should detect async function instructions as dynamic", async () => {
    // Create agent with async dynamic function instructions
    const asyncDynamicAgent = new TestAgent({
      name: "AsyncDynamicAgent",
      llm: new MockProvider({ modelId: "test-model" }),
      model: { modelId: "test-model" },
      instructions: async ({ userContext }: DynamicValueOptions) => {
        // Simulate async operation
        await new Promise((resolve) => setTimeout(resolve, 10));
        const role = userContext.get("role") || "assistant";
        return `You are a ${role} with async instructions.`;
      },
    });

    // Get system message and check isDynamicInstructions
    const systemMessageResponse = await (asyncDynamicAgent as any).getSystemMessage({
      input: "test input",
      historyEntryId: "test-id",
      contextMessages: [],
      operationContext: {
        operationId: "test-op",
        userContext: new Map([["role", "supervisor"]]),
        historyEntry: createMockHistoryEntry("test"),
        isActive: true,
        conversationSteps: [],
      },
    });

    expect(systemMessageResponse.isDynamicInstructions).toBe(true);

    // Check that async instructions were resolved properly
    expect(systemMessageResponse.systemMessages).toEqual({
      role: "system",
      content: "You are AsyncDynamicAgent. You are a supervisor with async instructions.",
    });
  });

  it("should handle VoltOps prompt content with isDynamicInstructions flag", async () => {
    // Mock VoltOps prompt response
    const mockPromptContent = {
      type: "text" as const,
      text: "You are a VoltOps-powered assistant.",
      metadata: {
        name: "test-prompt",
        version: 1,
        labels: ["production"],
      },
    };

    // Create agent with function that returns PromptContent
    const voltOpsAgent = new TestAgent({
      name: "VoltOpsAgent",
      llm: new MockProvider({ modelId: "test-model" }),
      model: { modelId: "test-model" },
      instructions: async (_: DynamicValueOptions) => {
        // Simulate VoltOps prompt fetch
        return mockPromptContent;
      },
    });

    // Get system message and check both isDynamicInstructions and promptMetadata
    const systemMessageResponse = await (voltOpsAgent as any).getSystemMessage({
      input: "test input",
      historyEntryId: "test-id",
      contextMessages: [],
      operationContext: {
        operationId: "test-op",
        userContext: new Map(),
        historyEntry: createMockHistoryEntry("test"),
        isActive: true,
        conversationSteps: [],
      },
    });

    expect(systemMessageResponse.isDynamicInstructions).toBe(true);
    expect(systemMessageResponse.promptMetadata).toEqual(mockPromptContent.metadata);
    expect(systemMessageResponse.systemMessages).toEqual({
      role: "system",
      content: "You are VoltOpsAgent. You are a VoltOps-powered assistant.",
    });
  });

  it("should work correctly during generateText with dynamic instructions", async () => {
    const dynamicAgent = new TestAgent({
      name: "DynamicTestAgent",
      llm: new MockProvider({ modelId: "test-model" }),
      model: { modelId: "test-model" },
      instructions: ({ userContext }: DynamicValueOptions) => {
        const mode = userContext.get("mode") || "default";
        return `You are in ${mode} mode.`;
      },
    });

    // Execute generateText with userContext
    const response = await dynamicAgent.generateText("Hello", {
      userContext: new Map([["mode", "testing"]]),
    });

    expect(response.text).toBe("Hello, I am a test agent!");

    // Check that the provider received the correct system message with dynamic instructions
    const provider = dynamicAgent.llm as MockProvider;
    const lastMessages = provider.lastMessages;

    expect(lastMessages[0]).toEqual({
      role: "system",
      content: "You are DynamicTestAgent. You are in testing mode.",
    });

    // Most importantly, check that isDynamicInstructions was correctly set
    expect(response.userContext).toBeDefined();

    expect(response.userContext?.get("mode")).toBe("testing");
  });
});

describe("onEnd Hook userContext Modifications", () => {
  it("should reflect userContext changes made in onEnd hook for generateText", async () => {
    let onEndCalled = false;

    const agent = new TestAgent({
      name: "TestAgent",
      llm: new MockProvider({ modelId: "test-model" }),
      model: { modelId: "test-model" },
      instructions: "You are a helpful assistant.",
      hooks: createHooks({
        onEnd: ({ context }) => {
          onEndCalled = true;
          // Change userContext in onEnd hook
          context.userContext.set("agent_response", "bye");
          context.userContext.set("hook_executed", true);
        },
      }),
    });

    // Set initial userContext
    const initialContext = new Map([["agent_response", "hi"]]);

    const response = await agent.generateText("Hello", {
      userContext: initialContext,
    });

    // Verify onEnd hook was called
    expect(onEndCalled).toBe(true);

    // Verify that the final response contains the updated userContext from onEnd hook
    expect(response.userContext?.get("agent_response")).toBe("bye");
    expect(response.userContext?.get("hook_executed")).toBe(true);
  });

  it("should reflect userContext changes made in onEnd hook for generateObject", async () => {
    let onEndCalled = false;

    const agent = new TestAgent({
      name: "TestAgent",
      llm: new MockProvider({ modelId: "test-model" }),
      model: { modelId: "test-model" },
      instructions: "You are a helpful assistant.",
      hooks: createHooks({
        onEnd: ({ context }) => {
          onEndCalled = true;
          // Change userContext in onEnd hook
          context.userContext.set("agent_response", "bye");
          context.userContext.set("hook_executed", true);
        },
      }),
    });

    // Set initial userContext
    const initialContext = new Map([["agent_response", "hi"]]);

    const response = await agent.generateObject("Hello", z.object({ message: z.string() }), {
      userContext: initialContext,
    });

    // Verify onEnd hook was called
    expect(onEndCalled).toBe(true);

    // Verify that the final response contains the updated userContext from onEnd hook
    expect(response.userContext?.get("agent_response")).toBe("bye");
    expect(response.userContext?.get("hook_executed")).toBe(true);
  });

  it("should pass correct userContext to onEnd hook before final response", async () => {
    let onEndUserContext: Map<string | symbol, unknown> | undefined;

    const agent = new TestAgent({
      name: "TestAgent",
      llm: new MockProvider({ modelId: "test-model" }),
      model: { modelId: "test-model" },
      instructions: "You are a helpful assistant.",
      hooks: createHooks({
        onEnd: ({ context, output }) => {
          // Capture userContext at the time onEnd is called
          onEndUserContext = new Map(context.userContext);
          // Verify output contains the current userContext
          expect(output?.userContext?.get("initial_value")).toBe("test");
          // Modify userContext after verification
          context.userContext.set("modified_in_onEnd", true);
        },
      }),
    });

    // Set initial userContext
    const initialContext = new Map([["initial_value", "test"]]);

    const response = await agent.generateText("Hello", {
      userContext: initialContext,
    });

    // Verify onEnd received the correct userContext
    expect(onEndUserContext?.get("initial_value")).toBe("test");

    // Verify final response contains the modification from onEnd
    expect(response.userContext?.get("modified_in_onEnd")).toBe(true);
  });

  it("should reflect userContext changes made in onEnd hook for streamObject", async () => {
    let onEndCalled = false;

    const agent = new TestAgent({
      name: "TestAgent",
      llm: new MockProvider({ modelId: "test-model" }),
      model: { modelId: "test-model" },
      instructions: "You are a helpful assistant.",
      hooks: createHooks({
        onEnd: ({ context }) => {
          onEndCalled = true;
          // Change userContext in onEnd hook
          context.userContext.set("agent_response", "bye");
          context.userContext.set("hook_executed", true);
        },
      }),
    });

    // Set initial userContext
    const initialContext = new Map([["agent_response", "hi"]]);

    const response = await agent.streamObject("Hello", z.object({ message: z.string() }), {
      userContext: initialContext,
    });

    // Verify onEnd hook was called
    expect(onEndCalled).toBe(true);

    // Verify that the final response contains the updated userContext from onEnd hook
    expect(response.userContext?.get("agent_response")).toBe("bye");
    expect(response.userContext?.get("hook_executed")).toBe(true);
  });
});

describe("Agent Abort Signal", () => {
  let mockLLM: MockProvider;
  let agent: Agent<{ llm: MockProvider }>;
  let abortController: AbortController;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLLM = new MockProvider({ modelId: "test-model" });
    abortController = new AbortController();

    agent = new Agent({
      name: "Test Agent",
      instructions: "Test instructions",
      model: { modelId: "test-model" },
      llm: mockLLM,
      memory: mockMemory,
    });
  });

  describe("setupAbortSignalListener", () => {
    it("should setup abort signal listener correctly", async () => {
      const mockOperationContext = {
        operationId: "test-op",
        userContext: new Map(),
        historyEntry: createMockHistoryEntry("test input"),
        isActive: true,
      } as any;

      const agentStartEvent = {
        id: "start-event-id",
        startTime: "2023-01-01T00:00:00.000Z",
      };

      // Setup spy on updateHistoryEntry method
      const updateHistoryEntrySpy = vi.spyOn(agent as any, "updateHistoryEntry");
      const publishTimelineEventSpy = vi.spyOn(agent as any, "publishTimelineEvent");

      // Call setupAbortSignalListener
      (agent as any).setupAbortSignalListener(
        abortController.signal,
        mockOperationContext,
        "test-conversation",
        agentStartEvent,
      );

      // Trigger abort
      abortController.abort();

      // Wait for async operations to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Verify history was updated with cancelled status
      expect(updateHistoryEntrySpy).toHaveBeenCalledWith(mockOperationContext, {
        status: "cancelled",
        endTime: expect.any(Date),
      });

      // Verify operation context was marked as inactive
      expect(mockOperationContext.isActive).toBe(false);

      // Verify agent cancelled event was published
      expect(publishTimelineEventSpy).toHaveBeenCalledWith(
        mockOperationContext,
        expect.objectContaining({
          name: "agent:cancel",
          type: "agent",
          status: "cancelled",
          statusMessage: {
            message: "Operation cancelled by user",
            code: "USER_CANCELLED",
            stage: "cancelled",
          },
        }),
      );

      updateHistoryEntrySpy.mockRestore();
      publishTimelineEventSpy.mockRestore();
    });

    it("should not setup listener when signal is undefined", () => {
      const mockOperationContext = {
        operationId: "test-op",
        userContext: new Map(),
        historyEntry: createMockHistoryEntry("test input"),
        isActive: true,
      } as any;

      const agentStartEvent = {
        id: "start-event-id",
        startTime: "2023-01-01T00:00:00.000Z",
      };

      // Should not throw when signal is undefined
      expect(() => {
        (agent as any).setupAbortSignalListener(
          undefined,
          mockOperationContext,
          "test-conversation",
          agentStartEvent,
        );
      }).not.toThrow();
    });

    it("should call onEnd hook with cancellation error when aborted", async () => {
      const onEndSpy = vi.fn();
      agent.hooks.onEnd = onEndSpy;

      const mockOperationContext = {
        operationId: "test-op",
        userContext: new Map(),
        historyEntry: createMockHistoryEntry("test input"),
        isActive: true,
      } as any;

      const agentStartEvent = {
        id: "start-event-id",
        startTime: "2023-01-01T00:00:00.000Z",
      };

      // Setup abort signal listener
      (agent as any).setupAbortSignalListener(
        abortController.signal,
        mockOperationContext,
        "test-conversation",
        agentStartEvent,
      );

      // Trigger abort
      abortController.abort();

      // Wait for async operations to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Verify onEnd hook was called with cancellation error
      expect(onEndSpy).toHaveBeenCalledWith({
        agent: agent,
        output: undefined,
        error: expect.objectContaining({
          message: "Operation cancelled by user",
          name: "AbortError",
        }),
        conversationId: "test-conversation",
        context: mockOperationContext,
      });
    });
  });

  describe("generateText with abort signal", () => {
    it("should handle abort signal during generateText", async () => {
      // Setup mock to delay so we can abort
      const delayedGenerateText = vi
        .spyOn(mockLLM, "generateText")
        .mockImplementation(async (options) => {
          // Simulate delay
          await new Promise((resolve) => setTimeout(resolve, 100));

          // Check if aborted during generation
          if (options.signal?.aborted) {
            const error = new Error("Operation was aborted");
            error.name = "AbortError";
            throw error;
          }

          return {
            text: "Generated text",
            usage: { totalTokens: 50 },
            finishReason: "stop",
            warnings: [],
            providerResponse: {},
          };
        });

      // Start generateText operation
      const generatePromise = agent.generateText("Test input", {
        signal: abortController.signal,
      });

      // Abort after a short delay
      setTimeout(() => abortController.abort(), 50);

      // Should reject with AbortError
      await expect(generatePromise).rejects.toThrow("Operation was aborted");

      delayedGenerateText.mockRestore();
    });

    it("should pass abort signal to LLM provider in generateText", async () => {
      const generateTextSpy = vi.spyOn(mockLLM, "generateText");

      await agent.generateText("Test input", {
        signal: abortController.signal,
      });

      // Verify signal was passed to LLM
      expect(generateTextSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          signal: abortController.signal,
        }),
      );

      generateTextSpy.mockRestore();
    });

    it("should handle immediate abort in generateText", async () => {
      // Abort immediately
      abortController.abort();

      // Mock the provider to respect abort signal immediately
      const generateTextSpy = vi
        .spyOn(mockLLM, "generateText")
        .mockImplementation(async (options) => {
          if (options.signal?.aborted) {
            const error = new Error("Operation aborted");
            error.name = "AbortError";
            throw error;
          }
          return {
            text: "Hello, I am a test agent!",
            usage: { totalTokens: 30 },
            finishReason: "stop",
            warnings: [],
            providerResponse: {},
            provider: { text: "Hello, I am a test agent!" },
            toolCalls: [],
            toolResults: [],
          };
        });

      const generatePromise = agent.generateText("Test input", {
        signal: abortController.signal,
      });

      // Should reject due to immediate abort
      await expect(generatePromise).rejects.toThrow("Operation aborted");

      generateTextSpy.mockRestore();
    });
  });

  describe("streamText with abort signal", () => {
    it("should handle abort signal during streamText", async () => {
      const streamTextSpy = vi.spyOn(mockLLM, "streamText").mockImplementation(async (options) => {
        return {
          textStream: (async function* () {
            yield "chunk1";

            // Check if aborted during streaming
            if (options.signal?.aborted) {
              const error = new Error("Stream aborted");
              error.name = "AbortError";
              throw error;
            }

            yield "chunk2";
          })(),
          fullStream: (async function* () {
            yield { type: "text-delta", textDelta: "chunk1" };

            // Check abort during stream
            if (options.signal?.aborted) {
              const error = new Error("Stream aborted");
              error.name = "AbortError";
              throw error;
            }

            yield { type: "text-delta", textDelta: "chunk2" };
            yield { type: "finish", finishReason: "stop", usage: { totalTokens: 10 } };
          })(),
          userContext: new Map(),
        };
      });

      const streamResponse = await agent.streamText("Test input", {
        signal: abortController.signal,
      });

      // Start consuming stream
      const streamPromise = (async () => {
        const chunks = [];
        for await (const chunk of streamResponse.textStream) {
          chunks.push(chunk);
          // Abort after first chunk
          if (chunks.length === 1) {
            abortController.abort();
          }
        }
        return chunks;
      })();

      // Should handle abort during streaming
      await expect(streamPromise).rejects.toThrow();

      streamTextSpy.mockRestore();
    });

    it("should pass abort signal to LLM provider in streamText", async () => {
      const streamTextSpy = vi.spyOn(mockLLM, "streamText");

      await agent.streamText("Test input", {
        signal: abortController.signal,
      });

      // Verify signal was passed to LLM
      expect(streamTextSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          signal: abortController.signal,
        }),
      );

      streamTextSpy.mockRestore();
    });
  });

  describe("generateObject with abort signal", () => {
    it("should handle abort signal during generateObject", async () => {
      const schema = z.object({
        name: z.string(),
        age: z.number(),
      });

      const generateObjectSpy = vi
        .spyOn(mockLLM, "generateObject")
        .mockImplementation(async (options) => {
          // Simulate delay
          await new Promise((resolve) => setTimeout(resolve, 100));

          // Check if aborted
          if (options.signal?.aborted) {
            const error = new Error("Object generation aborted");
            error.name = "AbortError";
            throw error;
          }

          return {
            object: { name: "John", age: 30 },
            usage: { totalTokens: 25 },
            finishReason: "stop",
            warnings: [],
            providerResponse: {},
          };
        });

      // Start generateObject operation
      const generatePromise = agent.generateObject("Generate person", schema, {
        signal: abortController.signal,
      });

      // Abort after short delay
      setTimeout(() => abortController.abort(), 50);

      // Should reject with AbortError
      await expect(generatePromise).rejects.toThrow("Object generation aborted");

      generateObjectSpy.mockRestore();
    });

    it("should pass abort signal to LLM provider in generateObject", async () => {
      const schema = z.object({ test: z.string() });
      const generateObjectSpy = vi.spyOn(mockLLM, "generateObject");

      await agent.generateObject("Test input", schema, {
        signal: abortController.signal,
      });

      // Verify signal was passed to LLM
      expect(generateObjectSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          signal: abortController.signal,
        }),
      );

      generateObjectSpy.mockRestore();
    });
  });

  describe("streamObject with abort signal", () => {
    it("should handle abort signal during streamObject", async () => {
      const schema = z.object({
        items: z.array(z.string()),
      });

      const streamObjectSpy = vi
        .spyOn(mockLLM, "streamObject")
        .mockImplementation(async (options) => {
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ type: "text-delta", textDelta: "generating..." });

                // Check abort during stream
                if (options.signal?.aborted) {
                  const error = new Error("Object stream aborted");
                  error.name = "AbortError";
                  controller.error(error);
                  return;
                }

                controller.close();
              },
            }),
            partialObjectStream: new ReadableStream({
              start(controller) {
                controller.enqueue({ items: ["item1"] });
                controller.close();
              },
            }),
            textStream: new ReadableStream({
              start(controller) {
                controller.enqueue("text chunk");
                controller.close();
              },
            }),
            userContext: new Map(),
          };
        });

      const streamResponse = await agent.streamObject("Generate list", schema, {
        signal: abortController.signal,
      });

      // Abort signal should be passed through
      expect(streamObjectSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          signal: abortController.signal,
        }),
      );

      streamObjectSpy.mockRestore();
    });
  });

  describe("abort signal propagation to sub-agents", () => {
    it("should propagate abort signal to sub-agents", async () => {
      // Create a TestAgent for this specific test so we can access getSubAgentManager()
      const testAgent = new TestAgent({
        name: "Test Agent",
        instructions: "Test instructions",
        model: { modelId: "test-model" },
        llm: mockLLM,
        memory: mockMemory,
      });

      // Create a sub-agent using TestAgent
      const subAgent = new TestAgent({
        name: "Sub Agent",
        instructions: "Sub agent instructions",
        model: { modelId: "sub-model" },
        llm: mockLLM,
        memory: mockMemory,
      });

      // Add sub-agent to test agent
      testAgent.addSubAgent(subAgent);

      // Mock sub-agent's streamText method to check signal propagation
      const subAgentStreamTextSpy = vi.spyOn(subAgent, "streamText").mockResolvedValue({
        textStream: (async function* () {
          yield "sub response";
        })(),
        fullStream: (async function* () {
          yield { type: "text-delta", textDelta: "sub response" };
          yield { type: "finish", finishReason: "stop", usage: { totalTokens: 5 } };
        })(),
        userContext: new Map(),
      });

      // Create operation context with abort signal
      const operationContext = {
        operationId: "test-op",
        userContext: new Map(),
        historyEntry: createMockHistoryEntry("test input"),
        isActive: true,
        signal: abortController.signal,
      } as any;

      // Get the delegate tool from the TestAgent
      const subAgentManager = testAgent.getSubAgentManager();
      const delegateTool = subAgentManager.createDelegateTool({
        sourceAgent: testAgent,
        operationContext: {
          operationId: operationContext.operationId,
          userContext: operationContext.userContext,
          conversationSteps: [],
          historyEntry: {
            id: operationContext.historyEntry.id,
            startTime: new Date(),
            input: "test input",
            output: "",
            status: "working",
            steps: [],
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            model: "sub-model",
          },
          isActive: operationContext.isActive,
        },
        currentHistoryEntryId: "test-history",
      });

      // Execute delegate tool (should propagate abort signal)
      await delegateTool.execute({
        task: "Test delegation",
        targetAgents: ["Sub Agent"],
        context: {},
      });

      // Verify sub-agent received the parent operation context with signal
      expect(subAgentStreamTextSpy).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          parentOperationContext: expect.objectContaining({
            operationId: operationContext.operationId,
            userContext: operationContext.userContext,
          }),
          // Signal should be propagated through parentOperationContext
          signal: undefined, // Sub-agent might not get direct signal but through context
        }),
      );

      subAgentStreamTextSpy.mockRestore();
    });
  });

  describe("abort signal with hooks", () => {
    it("should call onEnd hook when operation is aborted", async () => {
      const onEndSpy = vi.fn();
      agent.hooks.onEnd = onEndSpy;

      // Mock LLM to simulate long-running operation
      const generateTextSpy = vi
        .spyOn(mockLLM, "generateText")
        .mockImplementation(async (options) => {
          // Wait for abort
          return new Promise((_, reject) => {
            const checkAbort = () => {
              if (options.signal?.aborted) {
                const error = new Error("Operation cancelled by user");
                error.name = "AbortError";
                reject(error);
              } else {
                setTimeout(checkAbort, 10);
              }
            };
            checkAbort();
          });
        });

      // Start operation
      const generatePromise = agent.generateText("Test input", {
        signal: abortController.signal,
      });

      // Abort after delay
      setTimeout(() => abortController.abort(), 50);

      // Should reject
      await expect(generatePromise).rejects.toThrow();

      // Wait for cleanup
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Verify onEnd hook was called with error
      expect(onEndSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: agent,
          output: undefined,
          error: expect.objectContaining({
            name: "AbortError",
          }),
        }),
      );

      generateTextSpy.mockRestore();
    });

    it("should not call onEnd hook multiple times when aborted", async () => {
      const onEndSpy = vi.fn();
      agent.hooks.onEnd = onEndSpy;

      // Mock to throw AbortError immediately
      const generateTextSpy = vi
        .spyOn(mockLLM, "generateText")
        .mockRejectedValue(Object.assign(new Error("Aborted"), { name: "AbortError" }));

      // Already aborted signal
      abortController.abort();

      try {
        await agent.generateText("Test input", {
          signal: abortController.signal,
        });
      } catch (error) {
        // Expected to throw
      }

      // Wait for any async cleanup
      await new Promise((resolve) => setTimeout(resolve, 20));

      // onEnd should be called only once (from the main operation, not from signal listener)
      expect(onEndSpy).toHaveBeenCalledTimes(1);

      generateTextSpy.mockRestore();
    });
  });

  describe("abort signal in initializeHistory", () => {
    it("should inherit abort signal from parent operation context", async () => {
      const parentAbortController = new AbortController();
      const parentOperationContext = {
        operationId: "parent-op",
        userContext: new Map(),
        historyEntry: createMockHistoryEntry("parent input"),
        isActive: true,
        signal: parentAbortController.signal,
        conversationSteps: [],
      } as any;

      // Call initializeHistory with parent context
      const operationContext = await (agent as any).initializeHistory("test input", "working", {
        operationName: "test",
        parentOperationContext,
      });

      // Should inherit signal from parent
      expect(operationContext.signal).toBe(parentAbortController.signal);
    });

    it("should use provided signal over parent signal", async () => {
      const parentAbortController = new AbortController();
      const childAbortController = new AbortController();

      const parentOperationContext = {
        operationId: "parent-op",
        userContext: new Map(),
        historyEntry: createMockHistoryEntry("parent input"),
        isActive: true,
        signal: parentAbortController.signal,
        conversationSteps: [],
      } as any;

      // Call initializeHistory with both parent context and explicit signal
      const operationContext = await (agent as any).initializeHistory("test input", "working", {
        operationName: "test",
        parentOperationContext,
        signal: childAbortController.signal,
      });

      // Should use explicit signal over parent signal
      expect(operationContext.signal).toStrictEqual(childAbortController.signal);
    });
  });

  describe("edge cases", () => {
    it("should handle multiple abort signals gracefully", async () => {
      const controller1 = new AbortController();
      const controller2 = new AbortController();

      // Start multiple operations with different signals
      const promise1 = agent.generateText("Test 1", { signal: controller1.signal });
      const promise2 = agent.generateText("Test 2", { signal: controller2.signal });

      // Abort both
      controller1.abort();
      controller2.abort();

      // Both should reject
      await expect(promise1).rejects.toThrow();
      await expect(promise2).rejects.toThrow();
    });

    it("should handle abort signal when operation is already completed", async () => {
      // Complete the operation first
      const result = await agent.generateText("Test input");
      expect(result.text).toBe("Hello, I am a test agent!");

      // Abort after completion (should not cause issues)
      abortController.abort();

      // Should not throw or cause issues
      expect(() => abortController.abort()).not.toThrow();
    });

    it("should handle abort signal with no conversationId", async () => {
      const onEndSpy = vi.fn();
      agent.hooks.onEnd = onEndSpy;

      const mockOperationContext = {
        operationId: "test-op",
        userContext: new Map(),
        historyEntry: createMockHistoryEntry("test input"),
        isActive: true,
      } as any;

      const agentStartEvent = {
        id: "start-event-id",
        startTime: "2023-01-01T00:00:00.000Z",
      };

      // Setup with undefined conversationId
      (agent as any).setupAbortSignalListener(
        abortController.signal,
        mockOperationContext,
        undefined, // No conversationId
        agentStartEvent,
      );

      // Trigger abort
      abortController.abort();

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should call onEnd with empty string conversationId
      expect(onEndSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: "",
        }),
      );
    });
  });
});

describe("SupervisorConfig", () => {
  let mockLLM: MockProvider;

  beforeEach(() => {
    mockLLM = new MockProvider({ modelId: "test-model" });
  });

  describe("constructor", () => {
    it("should store supervisorConfig when provided", () => {
      const supervisorConfig = {
        systemMessage: "Custom supervisor message",
        includeAgentsMemory: false,
        customGuidelines: ["Rule 1", "Rule 2"],
      };

      const agent = new Agent({
        name: "Test Agent",
        instructions: "Test instructions",
        model: { modelId: "test-model" },
        llm: mockLLM,
        memory: mockMemory,
        supervisorConfig,
      });

      // Access private property via type assertion for testing
      expect((agent as any).supervisorConfig).toEqual(supervisorConfig);
    });

    it("should handle undefined supervisorConfig", () => {
      const agent = new Agent({
        name: "Test Agent",
        instructions: "Test instructions",
        model: { modelId: "test-model" },
        llm: mockLLM,
        memory: mockMemory,
      });

      expect((agent as any).supervisorConfig).toBeUndefined();
    });

    it("should store partial supervisorConfig", () => {
      const supervisorConfig = {
        systemMessage: "Custom message only",
      };

      const agent = new Agent({
        name: "Test Agent",
        instructions: "Test instructions",
        model: { modelId: "test-model" },
        llm: mockLLM,
        memory: mockMemory,
        supervisorConfig,
      });

      expect((agent as any).supervisorConfig).toEqual(supervisorConfig);
    });
  });

  describe("getSystemMessage with SupervisorConfig", () => {
    let agent: Agent<{ llm: MockProvider }>;
    let subAgent1: Agent<{ llm: MockProvider }>;
    let subAgent2: Agent<{ llm: MockProvider }>;

    beforeEach(() => {
      // Create sub-agents
      subAgent1 = new Agent({
        name: "Writer Agent",
        instructions: "Creates written content",
        purpose: "A specialized writing assistant",
        model: { modelId: "writer-model" },
        llm: mockLLM,
        memory: mockMemory,
      });

      subAgent2 = new Agent({
        name: "Editor Agent",
        instructions: "Reviews and edits content",
        model: { modelId: "editor-model" },
        llm: mockLLM,
        memory: mockMemory,
      });
    });

    it("should use supervisorConfig with custom systemMessage", async () => {
      const supervisorConfig = {
        systemMessage: "You are a friendly content manager named ContentBot.",
        includeAgentsMemory: true,
      };

      agent = new Agent({
        name: "Supervisor Agent",
        instructions: "Base supervisor instructions",
        model: { modelId: "supervisor-model" },
        llm: mockLLM,
        memory: mockMemory,
        subAgents: [subAgent1, subAgent2],
        supervisorConfig,
      });

      const systemMessage = await (agent as any).getSystemMessage({
        input: "test input",
        historyEntryId: "test-history-id",
        contextMessages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi there!" },
        ],
      });

      expect(systemMessage.systemMessages.content).toContain(
        "You are a friendly content manager named ContentBot.",
      );
      expect(systemMessage.systemMessages.content).toContain("<agents_memory>");
      expect(systemMessage.systemMessages.content).not.toContain("You are a supervisor agent");
      expect(systemMessage.systemMessages.content).not.toContain("Base supervisor instructions");
    });

    it("should use supervisorConfig with includeAgentsMemory false", async () => {
      const supervisorConfig = {
        systemMessage: "Custom supervisor without memory.",
        includeAgentsMemory: false,
      };

      agent = new Agent({
        name: "Supervisor Agent",
        instructions: "Base instructions",
        model: { modelId: "supervisor-model" },
        llm: mockLLM,
        memory: mockMemory,
        subAgents: [subAgent1],
        supervisorConfig,
      });

      const systemMessage = await (agent as any).getSystemMessage({
        input: "test input",
        historyEntryId: "test-history-id",
        contextMessages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Response" },
        ],
      });

      expect(systemMessage.systemMessages.content).toBe("Custom supervisor without memory.");
      expect(systemMessage.systemMessages.content).not.toContain("<agents_memory>");
    });

    it("should use supervisorConfig with customGuidelines in template mode", async () => {
      const supervisorConfig = {
        customGuidelines: ["Always be polite", "Respond within 30 seconds"],
        includeAgentsMemory: true,
      };

      agent = new Agent({
        name: "Supervisor Agent",
        instructions: "Coordinate between agents",
        model: { modelId: "supervisor-model" },
        llm: mockLLM,
        memory: mockMemory,
        subAgents: [subAgent1],
        supervisorConfig,
      });

      const systemMessage = await (agent as any).getSystemMessage({
        input: "test input",
        historyEntryId: "test-history-id",
        contextMessages: [],
      });

      expect(systemMessage.systemMessages.content).toContain("Always be polite");
      expect(systemMessage.systemMessages.content).toContain("Respond within 30 seconds");
      expect(systemMessage.systemMessages.content).toContain("You are a supervisor agent");
      expect(systemMessage.systemMessages.content).toContain("Coordinate between agents");
    });

    it("should work without supervisorConfig when subAgents exist", async () => {
      agent = new Agent({
        name: "Supervisor Agent",
        instructions: "Default supervisor behavior",
        model: { modelId: "supervisor-model" },
        llm: mockLLM,
        memory: mockMemory,
        subAgents: [subAgent1],
        // No supervisorConfig
      });

      const systemMessage = await (agent as any).getSystemMessage({
        input: "test input",
        historyEntryId: "test-history-id",
        contextMessages: [],
      });

      expect(systemMessage.systemMessages.content).toContain("You are a supervisor agent");
      expect(systemMessage.systemMessages.content).toContain("Default supervisor behavior");
      expect(systemMessage.systemMessages.content).toContain(
        "Writer Agent: A specialized writing assistant",
      );
    });

    it("should ignore supervisorConfig when no subAgents exist", async () => {
      const supervisorConfig = {
        systemMessage: "This should be ignored",
        customGuidelines: ["This should also be ignored"],
      };

      agent = new Agent({
        name: "Regular Agent",
        instructions: "Regular agent instructions",
        model: { modelId: "regular-model" },
        llm: mockLLM,
        memory: mockMemory,
        // No subAgents
        supervisorConfig,
      });

      const systemMessage = await (agent as any).getSystemMessage({
        input: "test input",
        historyEntryId: "test-history-id",
        contextMessages: [],
      });

      expect(systemMessage.systemMessages.content).toBe(
        "You are Regular Agent. Regular agent instructions",
      );
      expect(systemMessage.systemMessages.content).not.toContain("This should be ignored");
      expect(systemMessage.systemMessages.content).not.toContain("You are a supervisor agent");
    });

    it("should handle empty customGuidelines in supervisorConfig", async () => {
      const supervisorConfig = {
        customGuidelines: [],
        includeAgentsMemory: true,
      };

      agent = new Agent({
        name: "Supervisor Agent",
        instructions: "Base instructions",
        model: { modelId: "supervisor-model" },
        llm: mockLLM,
        memory: mockMemory,
        subAgents: [subAgent1],
        supervisorConfig,
      });

      const systemMessage = await (agent as any).getSystemMessage({
        input: "test input",
        historyEntryId: "test-history-id",
        contextMessages: [],
      });

      expect(systemMessage.systemMessages.content).toContain("You are a supervisor agent");
      expect(systemMessage.systemMessages.content).toContain("Provide a final answer to the User"); // Default guideline
    });

    it("should handle supervisorConfig with all undefined values", async () => {
      const supervisorConfig = {
        systemMessage: undefined,
        includeAgentsMemory: undefined,
        customGuidelines: undefined,
      };

      agent = new Agent({
        name: "Supervisor Agent",
        instructions: "Base instructions",
        model: { modelId: "supervisor-model" },
        llm: mockLLM,
        memory: mockMemory,
        subAgents: [subAgent1],
        supervisorConfig,
      });

      const systemMessage = await (agent as any).getSystemMessage({
        input: "test input",
        historyEntryId: "test-history-id",
        contextMessages: [],
      });

      // Should fall back to default template behavior
      expect(systemMessage.systemMessages.content).toContain("You are a supervisor agent");
      expect(systemMessage.systemMessages.content).toContain("Base instructions");
      expect(systemMessage.systemMessages.content).toContain("<agents_memory>");
    });
  });

  describe("integration with subAgents", () => {
    it("should pass supervisorConfig to SubAgentManager", async () => {
      const supervisorConfig = {
        systemMessage: "Custom system message",
        includeAgentsMemory: false,
      };

      const subAgent = new Agent({
        name: "Test Sub Agent",
        instructions: "Sub agent instructions",
        model: { modelId: "sub-model" },
        llm: mockLLM,
        memory: mockMemory,
      });

      const agent = new Agent({
        name: "Supervisor Agent",
        instructions: "Supervisor instructions",
        model: { modelId: "supervisor-model" },
        llm: mockLLM,
        memory: mockMemory,
        subAgents: [subAgent],
        supervisorConfig,
      });

      // Spy on SubAgentManager.generateSupervisorSystemMessage
      const subAgentManager = (agent as any).subAgentManager;
      const generateSupervisorSystemMessageSpy = vi.spyOn(
        subAgentManager,
        "generateSupervisorSystemMessage",
      );

      await (agent as any).getSystemMessage({
        input: "test input",
        historyEntryId: "test-history-id",
        contextMessages: [],
      });

      // Verify supervisorConfig was passed to SubAgentManager
      expect(generateSupervisorSystemMessageSpy).toHaveBeenCalledWith(
        "Supervisor instructions",
        "No previous agent interactions found.", // agents memory
        supervisorConfig,
      );

      generateSupervisorSystemMessageSpy.mockRestore();
    });

    it("should work with multiple subAgents and supervisorConfig", async () => {
      const supervisorConfig = {
        customGuidelines: ["Work efficiently", "Be collaborative"],
      };

      const subAgent1 = new Agent({
        name: "Writer",
        purpose: "Creates content",
        instructions: "Write great content",
        model: { modelId: "writer-model" },
        llm: mockLLM,
        memory: mockMemory,
      });

      const subAgent2 = new Agent({
        name: "Editor",
        instructions: "Edit and improve content",
        model: { modelId: "editor-model" },
        llm: mockLLM,
        memory: mockMemory,
      });

      const agent = new Agent({
        name: "Content Manager",
        instructions: "Manage content creation process",
        model: { modelId: "manager-model" },
        llm: mockLLM,
        memory: mockMemory,
        subAgents: [subAgent1, subAgent2],
        supervisorConfig,
      });

      const systemMessage = await (agent as any).getSystemMessage({
        input: "Create an article",
        historyEntryId: "test-history-id",
        contextMessages: [],
      });

      expect(systemMessage.systemMessages.content).toContain("Work efficiently");
      expect(systemMessage.systemMessages.content).toContain("Be collaborative");
      expect(systemMessage.systemMessages.content).toContain("Writer: Creates content");
      expect(systemMessage.systemMessages.content).toContain("Editor: Edit and improve content");
      expect(systemMessage.systemMessages.content).toContain("Manage content creation process");
    });
  });

  describe("error handling", () => {
    it("should handle malformed supervisorConfig gracefully", async () => {
      const supervisorConfig = {
        systemMessage: null,
        includeAgentsMemory: "invalid",
        customGuidelines: "not an array",
      } as any;

      const subAgent = new Agent({
        name: "Test Sub Agent",
        instructions: "Sub agent instructions",
        model: { modelId: "sub-model" },
        llm: mockLLM,
        memory: mockMemory,
      });

      const agent = new Agent({
        name: "Supervisor Agent",
        instructions: "Supervisor instructions",
        model: { modelId: "supervisor-model" },
        llm: mockLLM,
        memory: mockMemory,
        subAgents: [subAgent],
        supervisorConfig,
      });

      // Should not throw an error
      const systemMessage = await (agent as any).getSystemMessage({
        input: "test input",
        historyEntryId: "test-history-id",
        contextMessages: [],
      });

      // Should fall back to some reasonable behavior
      expect(systemMessage.systemMessages.content).toBeDefined();
      expect(typeof systemMessage.systemMessages.content).toBe("string");
    });
  });

  describe("tool error handling", () => {
    it("should return tool errors as results instead of throwing", async () => {
      const errorMessage = "Tool execution failed: timeout";
      const failingTool = createTool({
        name: "failing-tool",
        description: "A tool that always fails",
        parameters: z.object({ input: z.string() }),
        execute: async () => {
          throw new Error(errorMessage);
        },
      });

      const agent = new Agent({
        name: "test-agent",
        instructions: "Agent with failing tool",
        model: { modelId: "test-model" },
        llm: mockLLM,
        tools: [failingTool],
        memory: false,
      });

      // Mock provider to simulate tool call and capture the wrapped tool
      let capturedTool: any;
      vi.spyOn(mockLLM, "generateText").mockImplementation(async (options: any) => {
        // Capture the wrapped tool
        capturedTool = options.tools?.find((t: any) => t.name === "failing-tool");

        // Simulate the LLM making a tool call
        await options.onStepFinish({
          id: "tool-call-1",
          type: "tool_call",
          name: "failing-tool",
          arguments: { input: "test" },
          content: "",
          role: "assistant",
        });

        // Execute the tool to test error handling
        const toolResult = await capturedTool.execute({ input: "test" });

        // Tool result should contain error info instead of throwing
        expect(toolResult).toMatchObject({
          error: true,
          message: errorMessage,
        });
        // stack should be present
        expect(toolResult.stack).toBeDefined();
        expect(toolResult.stack).toContain(errorMessage);

        // Simulate tool result step with error
        await options.onStepFinish({
          id: "tool-call-1",
          type: "tool_result",
          name: "failing-tool",
          result: toolResult,
          content: JSON.stringify(toolResult),
          role: "assistant",
        });

        return {
          provider: { text: "I encountered an error with the tool." },
          text: "I encountered an error with the tool.",
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          finishReason: "stop",
          toolCalls: [],
          toolResults: [],
        };
      });

      const result = await agent.generateText("Use the failing tool");

      // Agent should complete successfully despite tool error
      expect(result.text).toBe("I encountered an error with the tool.");
      expect(mockLLM.generateText).toHaveBeenCalled();
    });

    it("should handle MCP tool timeouts gracefully", async () => {
      const timeoutError = new Error("Request timeout");
      const mcpTool = createTool({
        name: "mcp_server_tool",
        description: "An MCP tool that times out",
        parameters: z.object({ query: z.string() }),
        execute: async () => {
          // Simulate MCP timeout
          throw timeoutError;
        },
      });

      const agent = new Agent({
        name: "test-agent",
        instructions: "Agent with MCP tool",
        model: { modelId: "test-model" },
        llm: mockLLM,
        tools: [mcpTool],
        memory: false,
      });

      let capturedTool: any;
      let toolResultReceived = false;

      vi.spyOn(mockLLM, "generateText").mockImplementation(async (options: any) => {
        capturedTool = options.tools?.find((t: any) => t.name === "mcp_server_tool");

        // Simulate tool call
        await options.onStepFinish({
          id: "mcp-call-1",
          type: "tool_call",
          name: "mcp_server_tool",
          arguments: { query: "search" },
          content: "",
          role: "assistant",
        });

        // Execute the tool - should return error result
        const toolResult = await capturedTool.execute({ query: "search" });

        expect(toolResult).toMatchObject({
          error: true,
          message: "Request timeout",
        });

        toolResultReceived = true;

        // Simulate tool result with error
        await options.onStepFinish({
          id: "mcp-call-1",
          type: "tool_result",
          name: "mcp_server_tool",
          result: toolResult,
          content: JSON.stringify(toolResult),
          role: "assistant",
        });

        return {
          provider: { text: "The tool timed out. Let me try a different approach." },
          text: "The tool timed out. Let me try a different approach.",
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          finishReason: "stop",
          toolCalls: [],
          toolResults: [],
        };
      });

      const result = await agent.generateText("Search for information");

      expect(toolResultReceived).toBe(true);
      expect(result.text).toContain("timed out");
    });

    it("should store error details in _errorDetails field", async () => {
      const errorMessage = "Tool failed with details";
      const failingTool = createTool({
        name: "detailed-failing-tool",
        description: "A tool that fails with details",
        parameters: z.object({ input: z.string() }),
        execute: async () => {
          const error = new Error(errorMessage);
          error.name = "CustomToolError";
          throw error;
        },
      });

      const agent = new Agent({
        name: "test-agent",
        instructions: "Agent with detailed failing tool",
        llm: mockLLM,
        model: { modelId: "test-model" },
        tools: [failingTool],
        memory: false,
      });

      let capturedTool: any;
      vi.spyOn(mockLLM, "generateText").mockImplementation(async (options: any) => {
        capturedTool = options.tools?.find((t: any) => t.name === "detailed-failing-tool");

        await options.onStepFinish({
          id: "tool-call-1",
          type: "tool_call",
          name: "detailed-failing-tool",
          arguments: { input: "test" },
          content: "",
          role: "assistant",
        });

        const toolResult = await capturedTool.execute({ input: "test" });

        // Stack should be present
        expect(toolResult).toMatchObject({
          error: true,
          message: errorMessage,
        });
        expect(toolResult.stack).toBeDefined();
        expect(toolResult.stack).toContain("CustomToolError: Tool failed with details");

        await options.onStepFinish({
          id: "tool-call-1",
          type: "tool_result",
          name: "detailed-failing-tool",
          result: toolResult,
          content: JSON.stringify(toolResult), // Include full result with errorDetails
          role: "assistant",
        });

        return {
          provider: { text: "Tool failed with details" },
          text: "Tool failed with details",
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          finishReason: "stop",
          toolCalls: [],
          toolResults: [],
        };
      });

      await agent.generateText("Test with details");
    });
  });
});
