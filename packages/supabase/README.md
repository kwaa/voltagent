<div align="center">
<a href="https://voltagent.dev/">
<img width="1800" alt="VoltAgent Supabase Provider Banner" src="https://github.com/user-attachments/assets/452a03e7-eeda-4394-9ee7-0ffbcf37245c" />
</a>

<br/>
<br/>

<div align="center">
    <a href="https://voltagent.dev">Home Page</a> |
    <a href="https://voltagent.dev/docs/">Documentation</a> |
    <a href="https://github.com/voltagent/voltagent/tree/main/examples">Examples</a> |
    <a href="https://s.voltagent.dev/discord">Discord</a> |
    <a href="https://voltagent.dev/blog/">Blog</a>
</div>
</div>

<br/>

<div align="center">
    <strong>VoltAgent is an open source TypeScript framework for building and orchestrating AI agents.</strong><br>
Escape the limitations of no-code builders and the complexity of starting from scratch.
    <br />
    <br />
</div>

<div align="center">
    
[![npm version](https://img.shields.io/npm/v/@voltagent/core.svg)](https://www.npmjs.com/package/@voltagent/core)
[![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.0-4baaaa.svg)](CODE_OF_CONDUCT.md)
[![Discord](https://img.shields.io/discord/1361559153780195478.svg?label=&logo=discord&logoColor=ffffff&color=7389D8&labelColor=6A7EC2)](https://s.voltagent.dev/discord)
[![Twitter Follow](https://img.shields.io/twitter/follow/voltagent_dev?style=social)](https://twitter.com/voltagent_dev)
    
</div>

<br/>

<div align="center">
<a href="https://voltagent.dev/">
<img width="896" alt="flow" src="https://github.com/user-attachments/assets/f0627868-6153-4f63-ba7f-bdfcc5dd603d" />
</a>

</div>

## Setup

### Install Package

```bash
npm install @voltagent/supabase @supabase/supabase-js
# or
yarn add @voltagent/supabase @supabase/supabase-js
# or
pnpm add @voltagent/supabase @supabase/supabase-js
```

### Database Setup

This memory provider requires specific tables to exist in your Supabase database. Run the following SQL commands in your Supabase project's SQL Editor (Dashboard -> SQL Editor -> New query) to create the necessary tables and indexes.

**Note:** These commands use the default table prefix `voltagent_memory`. If you provide a custom `tableName` option when initializing `SupabaseMemory` (e.g., `new SupabaseMemory({ ..., tableName: 'my_custom_prefix' })`), you **must** replace `voltagent_memory` with `my_custom_prefix` in the SQL commands below.

```sql
-- Conversations Table
CREATE TABLE IF NOT EXISTS voltagent_memory_conversations (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    title TEXT,
    metadata JSONB, -- Use JSONB for efficient querying
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Index for faster lookup by resource_id
CREATE INDEX IF NOT EXISTS idx_voltagent_memory_conversations_resource
ON voltagent_memory_conversations(resource_id);

-- Messages Table
CREATE TABLE IF NOT EXISTS voltagent_memory_messages (
    user_id TEXT NOT NULL,
    -- Add foreign key reference and cascade delete
    conversation_id TEXT NOT NULL REFERENCES voltagent_memory_conversations(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL, -- Consider JSONB if content is often structured
    type TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    -- Composite primary key to ensure message uniqueness within a conversation
    PRIMARY KEY (user_id, conversation_id, message_id)
);

-- Index for faster message retrieval
CREATE INDEX IF NOT EXISTS idx_voltagent_memory_messages_lookup
ON voltagent_memory_messages(user_id, conversation_id, created_at);

-- Agent History Table (New Structured Format)
CREATE TABLE IF NOT EXISTS voltagent_memory_agent_history (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    status TEXT,
    input JSONB,
    output JSONB,
    usage JSONB,
    metadata JSONB,
    user_id TEXT,
    conversation_id TEXT,
    -- Legacy columns for migration compatibility
    key TEXT,
    value JSONB
);

-- Indexes for agent history
CREATE INDEX IF NOT EXISTS idx_voltagent_memory_agent_history_id
ON voltagent_memory_agent_history(id);

CREATE INDEX IF NOT EXISTS idx_voltagent_memory_agent_history_agent_id
ON voltagent_memory_agent_history(agent_id);

-- Agent History Steps Table
CREATE TABLE IF NOT EXISTS voltagent_memory_agent_history_steps (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL, -- Store the step object as JSONB
    -- Foreign key to history entry
    history_id TEXT NOT NULL,
    agent_id TEXT NOT NULL
);

-- Indexes for faster lookup
CREATE INDEX IF NOT EXISTS idx_voltagent_memory_agent_history_steps_history_id
ON voltagent_memory_agent_history_steps(history_id);

CREATE INDEX IF NOT EXISTS idx_voltagent_memory_agent_history_steps_agent_id
ON voltagent_memory_agent_history_steps(agent_id);

-- Timeline Events Table (New)
CREATE TABLE IF NOT EXISTS voltagent_memory_agent_history_timeline_events (
    id TEXT PRIMARY KEY,
    history_id TEXT NOT NULL,
    agent_id TEXT,
    event_type TEXT NOT NULL,
    event_name TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT,
    status TEXT,
    status_message TEXT,
    level TEXT DEFAULT 'INFO',
    version TEXT,
    parent_event_id TEXT,
    tags JSONB,
    input JSONB,
    output JSONB,
    error JSONB,
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for timeline events
CREATE INDEX IF NOT EXISTS idx_voltagent_memory_timeline_events_history_id
ON voltagent_memory_agent_history_timeline_events(history_id);

CREATE INDEX IF NOT EXISTS idx_voltagent_memory_timeline_events_agent_id
ON voltagent_memory_agent_history_timeline_events(agent_id);

CREATE INDEX IF NOT EXISTS idx_voltagent_memory_timeline_events_event_type
ON voltagent_memory_agent_history_timeline_events(event_type);

CREATE INDEX IF NOT EXISTS idx_voltagent_memory_timeline_events_event_name
ON voltagent_memory_agent_history_timeline_events(event_name);

CREATE INDEX IF NOT EXISTS idx_voltagent_memory_timeline_events_parent_event_id
ON voltagent_memory_agent_history_timeline_events(parent_event_id);

CREATE INDEX IF NOT EXISTS idx_voltagent_memory_timeline_events_status
ON voltagent_memory_agent_history_timeline_events(status);
```

### Credentials

Find your Supabase Project URL and anon key in your Supabase project settings (Project Settings -> API section). These are typically stored in environment variables (e.g., `.env` file) and accessed via `process.env`.

## Usage

Import `SupabaseMemory` and initialize it with your Supabase credentials:

```typescript
import { SupabaseMemory } from "@voltagent/supabase";
import { Agent } from "@voltagent/core";
// ... other imports

const supabaseUrl = process.env.SUPABASE_URL; // Use environment variables
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Supabase URL and Key are required.");
}

const memory = new SupabaseMemory({
  supabaseUrl,
  supabaseKey,
  // Optional: Specify a custom base table name prefix
  // tableName: 'my_custom_prefix',
  // Optional: Configure storage limits and debugging
  storageLimit: 100, // Maximum messages per conversation (default: 100, set to 0 for unlimited)
  debug: false, // Enable debug logging (default: false)
});

// Pass the memory instance to your Agent
const agent = new Agent({
  name: "my-agent",
  instructions: "A helpful assistant that answers questions without using tools",
  // ... other agent config
  memory: memory,
});

// ... rest of your VoltAgent setup
```

## Configuration Options

### Storage Limits

The Supabase memory provider supports automatic message pruning to manage storage efficiently:

```typescript
const memory = new SupabaseMemory({
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_KEY,
  storageLimit: 100, // Keep only the latest 100 messages per conversation. default: 100
});
```

When a storage limit is set, the provider automatically removes the oldest messages when the limit is exceeded. This helps:

- Control database storage costs
- Maintain conversation performance
- Manage memory usage for long-running conversations

### Debug Mode

Enable debug logging to troubleshoot issues:

```typescript
const memory = new SupabaseMemory({
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_KEY,
  debug: true, // Enables detailed logging
});
```

### Using an Existing Supabase Client

If you already have a Supabase client instance:

```typescript
import { createClient } from "@supabase/supabase-js";

const supabaseClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const memory = new SupabaseMemory({
  client: supabaseClient,
  storageLimit: 50,
  debug: true,
});
```

## What is VoltAgent?

> An **AI Agent Framework** provides the foundational structure and tools needed to build applications powered by autonomous agents. These agents, often driven by Large Language Models (LLMs), can perceive their environment, make decisions, and take actions to achieve specific goals. Building such agents from scratch involves managing complex interactions with LLMs, handling state, connecting to external tools and data, and orchestrating workflows.

**VoltAgent** is an open-source TypeScript framework that acts as this essential toolkit. It simplifies the development of AI agent applications by providing modular building blocks, standardized patterns, and abstractions. Whether you're creating chatbots, virtual assistants, automated workflows, or complex multi-agent systems, VoltAgent handles the underlying complexity, allowing you to focus on defining your agents' capabilities and logic.

Instead of building everything from scratch, VoltAgent provides ready-made, modular building blocks:

- **Core Engine (`@voltagent/core`)**: The heart of VoltAgent, providing fundamental capabilities for your AI agents Define individual agents with specific roles, tools, and memory.
- **Multi-Agent Systems**: Architect complex applications by coordinating multiple specialized agents using Supervisors.
- **Extensible Packages**: Enhance functionality with packages like `@voltagent/voice` for voice interactions.
- **Tooling & Integrations**: Equip agents with tools to connect to external APIs, databases, and services, enabling them to perform real-world tasks. **Supports the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) for standardized tool interactions.**
- **Data Retrieval & RAG**: Implement specialized retriever agents for efficient information fetching and **Retrieval-Augmented Generation (RAG)**.
- **Memory**: Enable agents to remember past interactions for more natural and context-aware conversations.
- **LLM Compatibility**: Works with popular AI models from OpenAI, Google, Anthropic, and more, allowing easy switching.
- **Developer Ecosystem**: Includes helpers like `create-voltagent-app`, `@voltagent/cli`, and the visual [VoltOps LLM Observability Platform](https://console.voltagent.dev) for quick setup, monitoring, and debugging.

In essence, VoltAgent helps developers build sophisticated AI applications faster and more reliably, avoiding repetitive setup and the limitations of simpler tools.

## Why VoltAgent?

Building AI applications often involves a trade-off:

1.  **DIY Approach:** Using basic AI provider tools offers control but leads to complex, hard-to-manage code and repeated effort.
2.  **No-Code Builders:** Simpler initially but often restrictive, limiting customization, provider choice, and complexity.

VoltAgent provides a middle ground, offering structure and components without sacrificing flexibility:

- **Build Faster:** Accelerate development with pre-built components compared to starting from scratch.
- **Maintainable Code:** Encourages organization for easier updates and debugging.
- **Scalability:** Start simple and easily scale to complex, multi-agent systems handling intricate workflows.
- **Flexibility:** Full control over agent behavior, LLM choice, tool integrations, and UI connections.
- **Avoid Lock-in:** Freedom to switch AI providers and models as needed.
- **Cost Efficiency:** Features designed to optimize AI service usage and reduce redundant calls.
- **Visual Monitoring:** Use the [VoltOps LLM Observability Platform](https://console.voltagent.dev) to track agent performance, inspect state, and debug visually.

VoltAgent empowers developers to build their envisioned AI applications efficiently, from simple helpers to complex systems.

## ⚡ Quick Start

Create a new VoltAgent project in seconds using the `create-voltagent-app` CLI tool:

```bash
npm create voltagent-app@latest
```

This command guides you through setup.

You'll see the starter code in `src/index.ts` to get you started with the VoltAgent framework.

```typescript
import { VoltAgent, Agent } from "@voltagent/core";
import { VercelAIProvider } from "@voltagent/vercel-ai"; // Example provider
import { openai } from "@ai-sdk/openai"; // Example model

// Define a simple agent
const agent = new Agent({
  name: "my-agent",
  instructions: "A helpful assistant that answers questions without using tools",
  // Note: You can swap VercelAIProvider and openai with other supported providers/models
  llm: new VercelAIProvider(),
  model: openai("gpt-4o-mini"),
});

// Initialize VoltAgent with your agent(s)
new VoltAgent({
  agents: {
    agent,
  },
});
```

Afterwards, navigate to your project and run:

```bash
npm run dev
```

When you run the dev command, tsx will compile and run your code. You should see the VoltAgent server startup message in your terminal:

```
══════════════════════════════════════════════════
VOLTAGENT SERVER STARTED SUCCESSFULLY
══════════════════════════════════════════════════
✓ HTTP Server: http://localhost:3141

Test your agents with VoltOps Console: https://console.voltagent.dev
══════════════════════════════════════════════════
```

Your agent is now running! To interact with it:

1. Open the Console: Click the [VoltOps LLM Observability Platform](https://console.voltagent.dev) link in your terminal output (or copy-paste it into your browser).
2. Find Your Agent: On the VoltOps LLM Observability Platform page, you should see your agent listed (e.g., "my-agent").
3. Open Agent Details: Click on your agent's name.
4. Start Chatting: On the agent detail page, click the chat icon in the bottom right corner to open the chat window.
5. Send a Message: Type a message like "Hello" and press Enter.

![VoltAgent VoltOps Platform Demo](https://github.com/user-attachments/assets/0adbec33-1373-4cf4-b67d-825f7baf1cb4)

## Key Features

- **Agent Core:** Define agents with descriptions, LLM providers, tools, and memory management.
- **Multi-Agent Systems:** Build complex workflows using Supervisor Agents coordinating multiple specialized Sub-Agents.
- **Tool Usage & Lifecycle:** Equip agents with custom or pre-built tools (functions) with type-safety (Zod), lifecycle hooks, and cancellation support to interact with external systems.
- **Flexible LLM Support:** Integrate seamlessly with various LLM providers (OpenAI, Anthropic, Google, etc.) and easily switch between models.
- **Memory Management:** Enable agents to retain context across interactions using different configurable memory providers.
- **Observability & Debugging:** Visually monitor agent states, interactions, logs, and performance via the [VoltOps LLM Observability Platform](https://console.voltagent.dev).
- **Voice Interaction:** Build voice-enabled agents capable of speech recognition and synthesis using the `@voltagent/voice` package.
- **Data Retrieval & RAG:** Integrate specialized retriever agents for efficient information fetching and **Retrieval-Augmented Generation (RAG)** from various sources.
- **Model Context Protocol (MCP) Support:** Connect to external tool servers (HTTP/stdio) adhering to the [MCP standard](https://modelcontextprotocol.io/) for extended capabilities.
- **Prompt Engineering Tools:** Leverage utilities like `createPrompt` for crafting and managing effective prompts for your agents.
- **Framework Compatibility:** Designed for easy integration into existing Node.js applications and popular frameworks.

## Use Cases

VoltAgent is versatile and can power a wide range of AI-driven applications:

- **Complex Workflow Automation:** Orchestrate multi-step processes involving various tools, APIs, and decision points using coordinated agents.
- **Intelligent Data Pipelines:** Build agents that fetch, process, analyze, and transform data from diverse sources.
- **AI-Powered Internal Tools & Dashboards:** Create interactive internal applications that leverage AI for analysis, reporting, or task automation, often integrated with UIs using hooks.
- **Automated Customer Support Agents:** Develop sophisticated chatbots that can understand context (memory), use tools (e.g., check order status), and escalate complex issues.
- **Repository Analysis & Codebase Automation:** Analyze code repositories, automate refactoring tasks, generate documentation, or manage CI/CD processes.
- **Retrieval-Augmented Generation (RAG) Systems:** Build agents that retrieve relevant information from knowledge bases (using retriever agents) before generating informed responses.
- **Voice-Controlled Interfaces & Applications:** Utilize the `@voltagent/voice` package to create applications that respond to and generate spoken language.
- **Personalized User Experiences:** Develop agents that adapt responses and actions based on user history and preferences stored in memory.
- **Real-time Monitoring & Alerting:** Design agents that continuously monitor data streams or systems and trigger actions or notifications based on defined conditions.
- **And Virtually Anything Else...**: If you can imagine an AI agent doing it, VoltAgent can likely help you build it! ⚡

## Learning VoltAgent

- **[Documentation](https://voltagent.dev/docs/)**: Dive into guides, concepts, and tutorials.
- **[Examples](https://github.com/voltagent/voltagent/tree/main/examples)**: Explore practical implementations.
- **[Blog](https://voltagent.dev/blog/)**: Read more about technical insights, and best practices.

## Contribution

We welcome contributions! Please refer to the contribution guidelines (link needed if available). Join our [Discord](https://s.voltagent.dev/discord) server for questions and discussions.

## Community ♥️ Thanks

Your stars help us reach more developers! If you find VoltAgent useful, please consider giving us a star on GitHub to support the project and help others discover it.

## License

Licensed under the MIT License, Copyright © 2025-present VoltAgent.
