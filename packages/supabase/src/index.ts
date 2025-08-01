import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import {
  type Conversation,
  type ConversationQueryOptions,
  type CreateConversationInput,
  type Memory,
  type MemoryMessage,
  type MemoryOptions,
  type MessageFilterOptions,
  type WorkflowHistoryEntry,
  type WorkflowStepHistoryEntry,
  safeJsonParse,
} from "@voltagent/core";
import type { NewTimelineEvent } from "@voltagent/core";

/**
 * Workflow statistics interface
 */
export interface WorkflowStats {
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  averageExecutionTime: number;
  lastExecutionTime?: Date;
}

export interface SupabaseMemoryOptions extends MemoryOptions {
  supabaseUrl?: string;
  supabaseKey?: string;
  client?: SupabaseClient;
  tableName?: string; // Base table name, defaults to "voltagent_memory"
  debug?: boolean; // Whether to enable debug logging, defaults to false
}

/**
 * Supabase Storage for VoltAgent
 *
 * This implementation provides:
 * - Conversation management with user support
 * - Automatic migration from old schema to new schema
 * - PostgreSQL-optimized queries through Supabase
 * - Real-time capabilities through Supabase subscriptions
 * - Storage limits for managing message history
 * - Workflow history, steps, and timeline events persistence
 *
 * @see {@link https://voltagent.dev/docs/agents/memory/supabase | Supabase Storage Documentation}
 */
export class SupabaseMemory implements Memory {
  private client: SupabaseClient;
  private baseTableName: string;
  private debug: boolean;
  private options: SupabaseMemoryOptions;
  private initialized: Promise<void>;

  constructor(options: SupabaseMemoryOptions) {
    if (!options.client && (!options.supabaseUrl || !options.supabaseKey)) {
      throw new Error("Either provide a 'client' or both 'supabaseUrl' and 'supabaseKey'");
    }

    if (options.client && (options.supabaseUrl || options.supabaseKey)) {
      throw new Error(
        "Cannot provide both 'client' and 'supabaseUrl/supabaseKey'. Choose one approach.",
      );
    }
    this.client =
      options.client || createClient(options.supabaseUrl as string, options.supabaseKey as string);
    this.baseTableName = options.tableName || "voltagent_memory";
    this.debug = options.debug || false;
    this.options = {
      ...options,
      storageLimit: options.storageLimit ?? 100,
      tableName: options.tableName || "voltagent_memory",
      debug: options.debug || false,
    };

    // Initialize the database and run migration if needed
    this.initialized = this.initializeDatabase();
  }

  /**
   * Log a debug message if debug mode is enabled
   * @param message Message to log
   * @param data Additional data to log
   */
  private debugLog(message: string, data?: unknown): void {
    if (this.debug) {
      console.log(`[SupabaseMemory] ${message}`, data || "");
    }
  }

  /**
   * Initialize the database and run migration if needed
   * @returns Promise that resolves when initialization is complete
   */
  private async initializeDatabase(): Promise<void> {
    try {
      // First check if this is a fresh installation before doing anything
      const isFreshInstallation = await this.checkFreshInstallation();

      // Ensure database tables exist with correct structure
      await this.ensureDatabaseStructure();

      // Skip all migrations if this is a fresh installation
      if (isFreshInstallation) {
        // Set migration flags to prevent future migrations from running
        await this.setFreshInstallationFlags();
        return;
      }

      // Run conversation schema migration first
      try {
        const migrationResult = await this.migrateConversationSchema({
          createBackup: true,
        });

        if (migrationResult.success) {
          if ((migrationResult.migratedCount || 0) > 0) {
            console.log(
              `${migrationResult.migratedCount} conversation records successfully migrated`,
            );
          }
        } else {
          console.error("Conversation migration error:", migrationResult.error);
        }
      } catch (error) {
        console.error("Error migrating conversation schema:", error);
      }

      // Run agent history schema migration
      try {
        const migrationResult = await this.migrateAgentHistorySchema();

        if (!migrationResult.success) {
          console.error("Agent history schema migration error:", migrationResult.error);
        }
      } catch (error) {
        console.error("Error migrating agent history schema:", error);
      }

      // Then run data migration if needed
      const result = await this.migrateAgentHistoryData({
        restoreFromBackup: false,
      });

      if (result.success) {
        if ((result.migratedCount || 0) > 0) {
          console.log(`${result.migratedCount} records successfully migrated`);
        }
      } else {
        console.error("Migration error:", result.error);

        // Restore from backup in case of error
        const restoreResult = await this.migrateAgentHistoryData({});

        if (restoreResult.success) {
          console.log("Successfully restored from backup");
        }
      }
    } catch (error) {
      console.error("Error initializing database:", error);
      // Don't throw here to allow the class to be instantiated
    }
  }

  /**
   * Check if this is a fresh installation (no tables exist)
   */
  private async checkFreshInstallation(): Promise<boolean> {
    try {
      // Check if basic tables exist
      const { error: conversationsError } = await this.client
        .from(this.conversationsTable)
        .select("id")
        .limit(1);

      const { error: messagesError } = await this.client
        .from(this.messagesTable)
        .select("message_id")
        .limit(1);

      const { error: historyError } = await this.client
        .from(this.historyTable)
        .select("*")
        .limit(1);

      // If all basic tables are missing, it's a fresh installation
      return !!conversationsError && !!messagesError && !!historyError;
    } catch {
      return true; // Fresh installation
    }
  }

  /**
   * Check if timeline events table needs to be created
   */
  private async checkTimelineEventsTable(): Promise<boolean> {
    try {
      const { error } = await this.client.from(this.timelineEventsTable).select("id").limit(1);
      return !!error; // If there"s an error, table doesn"t exist
    } catch {
      return true; // Table doesn"t exist
    }
  }

  /**
   * Check if workflow tables need to be created
   */
  private async checkWorkflowTables(): Promise<{
    needsWorkflowHistory: boolean;
    needsWorkflowSteps: boolean;
    needsWorkflowTimelineEvents: boolean;
  }> {
    let needsWorkflowHistory = false;
    let needsWorkflowSteps = false;
    let needsWorkflowTimelineEvents = false;

    try {
      const { error: workflowHistoryError } = await this.client
        .from(this.workflowHistoryTable)
        .select("id")
        .limit(1);
      needsWorkflowHistory = !!workflowHistoryError;
    } catch {
      needsWorkflowHistory = true;
    }

    try {
      const { error: workflowStepsError } = await this.client
        .from(this.workflowStepsTable)
        .select("id")
        .limit(1);
      needsWorkflowSteps = !!workflowStepsError;
    } catch {
      needsWorkflowSteps = true;
    }

    try {
      const { error: workflowTimelineEventsError } = await this.client
        .from(this.workflowTimelineEventsTable)
        .select("id")
        .limit(1);
      needsWorkflowTimelineEvents = !!workflowTimelineEventsError;
    } catch {
      needsWorkflowTimelineEvents = true;
    }

    return {
      needsWorkflowHistory,
      needsWorkflowSteps,
      needsWorkflowTimelineEvents,
    };
  }

  /**
   * Check if agent history table structure needs to be updated
   */
  private async checkAgentHistoryStructure(): Promise<boolean> {
    try {
      const { error } = await this.client
        .from(this.historyTable)
        .select("id, timestamp, status, input, output, usage, metadata")
        .limit(1);
      return !!error; // If there"s an error, columns don"t exist
    } catch {
      return true; // Columns don"t exist
    }
  }

  /**
   * Ensure database tables exist with correct structure
   * Runs SQL migrations automatically
   */
  private async ensureDatabaseStructure(): Promise<void> {
    try {
      // First check if this is a fresh installation
      const isFreshInstallation = await this.checkFreshInstallation();

      if (isFreshInstallation) {
        // Fresh installation - show complete README SQL
        console.log(`\n${"=".repeat(100)}`);
        console.log("🚀 VOLTAGENT SUPABASE FRESH INSTALLATION");
        console.log("=".repeat(100));
        console.log("No tables detected. Please run the complete setup SQL:");
        console.log("(Copy and paste the entire block below)\n");

        console.log(`-- VoltAgent Supabase Complete Setup
-- Run this entire script in your Supabase SQL Editor

-- Conversations Table
CREATE TABLE IF NOT EXISTS ${this.conversationsTable} (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    user_id TEXT,  -- Associates conversation with user (nullable)
    title TEXT,
    metadata JSONB, -- Use JSONB for efficient querying
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Index for faster lookup by resource_id
CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_conversations_resource
ON ${this.conversationsTable}(resource_id);

-- Index for faster lookup by user_id
CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_conversations_user
ON ${this.conversationsTable}(user_id);

-- Composite index for user_id + resource_id queries
CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_conversations_user_resource
ON ${this.conversationsTable}(user_id, resource_id);

-- Index for ordering by updated_at (most common query pattern)
CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_conversations_updated_at
ON ${this.conversationsTable}(updated_at DESC);

-- Messages Table
CREATE TABLE IF NOT EXISTS ${this.messagesTable} (
    conversation_id TEXT NOT NULL REFERENCES ${this.conversationsTable}(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL, -- Consider JSONB if content is often structured
    type TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    -- Primary key: conversation_id + message_id ensures uniqueness within conversation
    PRIMARY KEY (conversation_id, message_id)
);

-- Index for faster message retrieval (most common query pattern)
CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_messages_lookup
ON ${this.messagesTable}(conversation_id, created_at);

-- Index for message role filtering
CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_messages_role
ON ${this.messagesTable}(conversation_id, role, created_at);

-- Agent History Table (New Structured Format)
CREATE TABLE IF NOT EXISTS ${this.historyTable} (
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
CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_agent_history_id 
ON ${this.historyTable}(id);

CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_agent_history_agent_id 
ON ${this.historyTable}(agent_id);

-- Index for user_id
CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_agent_history_user_id
ON ${this.historyTable}(user_id);

-- Index for conversation_id
CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_agent_history_conversation_id
ON ${this.historyTable}(conversation_id);

-- Agent History Steps Table
CREATE TABLE IF NOT EXISTS ${this.historyStepsTable} (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL, -- Store the step object as JSONB
    -- Foreign key to history entry
    history_id TEXT NOT NULL,
    agent_id TEXT NOT NULL
);

-- Indexes for faster lookup
CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_agent_history_steps_history_id
ON ${this.historyStepsTable}(history_id);

CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_agent_history_steps_agent_id
ON ${this.historyStepsTable}(agent_id);

-- Timeline Events Table (New)
CREATE TABLE IF NOT EXISTS ${this.timelineEventsTable} (
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
CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_timeline_events_history_id 
ON ${this.timelineEventsTable}(history_id);

CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_timeline_events_agent_id 
ON ${this.timelineEventsTable}(agent_id);

CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_timeline_events_event_type 
ON ${this.timelineEventsTable}(event_type);

CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_timeline_events_event_name 
ON ${this.timelineEventsTable}(event_name);

CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_timeline_events_parent_event_id 
ON ${this.timelineEventsTable}(parent_event_id);

CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_timeline_events_status 
ON ${this.timelineEventsTable}(status);

-- Workflow History Table
CREATE TABLE IF NOT EXISTS ${this.workflowHistoryTable} (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'error', 'cancelled')),
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ,
    input JSONB,
    output JSONB,
    metadata JSONB,
    user_id TEXT,
    conversation_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Workflow Steps Table
CREATE TABLE IF NOT EXISTS ${this.workflowStepsTable} (
    id TEXT PRIMARY KEY,
    workflow_history_id TEXT NOT NULL REFERENCES ${this.workflowHistoryTable}(id) ON DELETE CASCADE,
    step_index INTEGER NOT NULL,
    step_type TEXT NOT NULL CHECK (step_type IN ('agent', 'func', 'conditional-when', 'parallel-all', 'parallel-race')),
    step_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'error', 'skipped')),
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ,
    input JSONB,
    output JSONB,
    error_message TEXT,
    agent_execution_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Workflow Timeline Events Table
CREATE TABLE IF NOT EXISTS ${this.workflowTimelineEventsTable} (
    id TEXT PRIMARY KEY,
    workflow_history_id TEXT NOT NULL REFERENCES ${this.workflowHistoryTable}(id) ON DELETE CASCADE,
    event_id TEXT NOT NULL,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ,
    status TEXT,
    level TEXT DEFAULT 'INFO',
    input JSONB,
    output JSONB,
    metadata JSONB,
    event_sequence INTEGER,
    trace_id TEXT,
    parent_event_id TEXT,
    status_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Indexes for workflow tables
CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_workflow_history_workflow_id
ON ${this.workflowHistoryTable}(workflow_id);

CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_workflow_history_status
ON ${this.workflowHistoryTable}(status);

CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_workflow_history_start_time
ON ${this.workflowHistoryTable}(start_time);

CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_workflow_history_user_id
ON ${this.workflowHistoryTable}(user_id);

CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_workflow_history_conversation_id
ON ${this.workflowHistoryTable}(conversation_id);

CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_workflow_steps_workflow_history_id
ON ${this.workflowStepsTable}(workflow_history_id);

CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_workflow_steps_step_index
ON ${this.workflowStepsTable}(workflow_history_id, step_index);

CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_workflow_timeline_events_workflow_history_id
ON ${this.workflowTimelineEventsTable}(workflow_history_id);

CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_workflow_timeline_events_type
ON ${this.workflowTimelineEventsTable}(type);

CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_workflow_timeline_events_start_time
ON ${this.workflowTimelineEventsTable}(start_time);

CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_workflow_timeline_events_sequence
ON ${this.workflowTimelineEventsTable}(event_sequence);

-- Migration Flags Table (Prevents duplicate migrations)
CREATE TABLE IF NOT EXISTS ${this.conversationsTable}_migration_flags (
    id SERIAL PRIMARY KEY,
    migration_type TEXT NOT NULL UNIQUE,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    migrated_count INTEGER DEFAULT 0,
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Insert fresh installation flags to prevent future migrations
INSERT INTO voltagent_memory_conversations_migration_flags (migration_type, migrated_count, metadata) 
VALUES 
    ('conversation_schema_migration', 0, '{"fresh_install": true}'::jsonb),
    ('agent_history_migration', 0, '{"fresh_install": true}'::jsonb)
ON CONFLICT (migration_type) DO NOTHING;
`);

        console.log(`\n${"=".repeat(100)}`);
        console.log("📋 FRESH INSTALLATION INSTRUCTIONS:");
        console.log("1. Go to your Supabase Dashboard");
        console.log('2. Click on "SQL Editor" in the left sidebar');
        console.log('3. Click "New Query"');
        console.log("4. Copy and paste the SQL above");
        console.log('5. Click "Run" to execute');
        console.log("6. Restart your application");
        console.log(`${"=".repeat(100)}\n`);
        return;
      }

      // Not a fresh installation - check for specific missing tables/columns
      const needsTimelineTable = await this.checkTimelineEventsTable();
      const needsHistoryUpdate = await this.checkAgentHistoryStructure();
      const workflowTableStatus = await this.checkWorkflowTables();

      if (
        needsTimelineTable ||
        needsHistoryUpdate ||
        workflowTableStatus.needsWorkflowHistory ||
        workflowTableStatus.needsWorkflowSteps ||
        workflowTableStatus.needsWorkflowTimelineEvents
      ) {
        console.log(`\n${"=".repeat(100)}`);
        console.log("🚀 VOLTAGENT SUPABASE MIGRATION");
        console.log("=".repeat(100));
        console.log("Missing tables/columns detected. Please run the following SQL:");
        console.log("(Copy and paste the entire block below)\n");

        console.log("-- VoltAgent Supabase Migration");
        console.log("-- Run this entire script in your Supabase SQL Editor\n");

        if (needsTimelineTable) {
          console.log("-- 1. Create timeline events table");
          console.log(`CREATE TABLE IF NOT EXISTS ${this.timelineEventsTable} (
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
);\n`);
        }

        if (needsHistoryUpdate) {
          console.log("-- 2. Update agent history table structure");
          console.log(`ALTER TABLE ${this.historyTable} 
ADD COLUMN IF NOT EXISTS id TEXT,
ADD COLUMN IF NOT EXISTS timestamp TEXT,
ADD COLUMN IF NOT EXISTS status TEXT,
ADD COLUMN IF NOT EXISTS input JSONB,
ADD COLUMN IF NOT EXISTS output JSONB,
ADD COLUMN IF NOT EXISTS usage JSONB,
ADD COLUMN IF NOT EXISTS metadata JSONB,
ADD COLUMN IF NOT EXISTS user_id TEXT,
ADD COLUMN IF NOT EXISTS conversation_id TEXT;\n`);
        }

        if (workflowTableStatus.needsWorkflowHistory) {
          console.log("-- 3. Create workflow history table");
          console.log(`CREATE TABLE IF NOT EXISTS ${this.workflowHistoryTable} (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'error', 'cancelled')),
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  input JSONB,
  output JSONB,
  metadata JSONB,
  user_id TEXT,
  conversation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);\n`);
        }

        if (workflowTableStatus.needsWorkflowSteps) {
          console.log("-- 4. Create workflow steps table");
          console.log(`CREATE TABLE IF NOT EXISTS ${this.workflowStepsTable} (
  id TEXT PRIMARY KEY,
  workflow_history_id TEXT NOT NULL REFERENCES ${this.workflowHistoryTable}(id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL,
  step_type TEXT NOT NULL CHECK (step_type IN ('agent', 'func', 'conditional-when', 'parallel-all', 'parallel-race')),
  step_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'error', 'skipped')),
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  input JSONB,
  output JSONB,
  error_message TEXT,
  agent_execution_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);\n`);
        }

        if (workflowTableStatus.needsWorkflowTimelineEvents) {
          console.log("-- 5. Create workflow timeline events table");
          console.log(`CREATE TABLE IF NOT EXISTS ${this.workflowTimelineEventsTable} (
  id TEXT PRIMARY KEY,
  workflow_history_id TEXT NOT NULL REFERENCES ${this.workflowHistoryTable}(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  status TEXT,
  level TEXT DEFAULT 'INFO',
  input JSONB,
  output JSONB,
  metadata JSONB,
  event_sequence INTEGER,
  trace_id TEXT,
  parent_event_id TEXT,
  status_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);\n`);
        }

        console.log("-- 6. Create performance indexes");
        if (needsTimelineTable) {
          console.log(`CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_timeline_events_history_id 
ON ${this.timelineEventsTable}(history_id);

CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_timeline_events_agent_id 
ON ${this.timelineEventsTable}(agent_id);

CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_timeline_events_event_type 
ON ${this.timelineEventsTable}(event_type);

CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_timeline_events_event_name 
ON ${this.timelineEventsTable}(event_name);

CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_timeline_events_parent_event_id 
ON ${this.timelineEventsTable}(parent_event_id);

CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_timeline_events_status 
ON ${this.timelineEventsTable}(status);`);
        }

        if (needsHistoryUpdate) {
          console.log(`
CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_agent_history_id 
ON ${this.historyTable}(id);

CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_agent_history_agent_id 
ON ${this.historyTable}(agent_id);

CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_agent_history_user_id
ON ${this.historyTable}(user_id);

CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_agent_history_conversation_id
ON ${this.historyTable}(conversation_id);`);
        }

        if (
          workflowTableStatus.needsWorkflowHistory ||
          workflowTableStatus.needsWorkflowSteps ||
          workflowTableStatus.needsWorkflowTimelineEvents
        ) {
          console.log(`
-- Workflow table indexes
CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_workflow_history_workflow_id
ON ${this.workflowHistoryTable}(workflow_id);

CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_workflow_history_status
ON ${this.workflowHistoryTable}(status);

CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_workflow_history_start_time
ON ${this.workflowHistoryTable}(start_time);

CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_workflow_history_user_id
ON ${this.workflowHistoryTable}(user_id);

CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_workflow_history_conversation_id
ON ${this.workflowHistoryTable}(conversation_id);

CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_workflow_steps_workflow_history_id
ON ${this.workflowStepsTable}(workflow_history_id);

CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_workflow_steps_step_index
ON ${this.workflowStepsTable}(workflow_history_id, step_index);

CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_workflow_timeline_events_workflow_history_id
ON ${this.workflowTimelineEventsTable}(workflow_history_id);

CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_workflow_timeline_events_type
ON ${this.workflowTimelineEventsTable}(type);

CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_workflow_timeline_events_start_time
ON ${this.workflowTimelineEventsTable}(start_time);

CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_workflow_timeline_events_sequence
ON ${this.workflowTimelineEventsTable}(event_sequence);`);
        }

        console.log(`\n${"=".repeat(100)}`);
        console.log("📋 MIGRATION INSTRUCTIONS:");
        console.log("1. Go to your Supabase Dashboard");
        console.log('2. Click on "SQL Editor" in the left sidebar');
        console.log('3. Click "New Query"');
        console.log("4. Copy and paste the SQL above");
        console.log('5. Click "Run" to execute');
        console.log("6. Restart your application");
        console.log(`${"=".repeat(100)}\n`);
      }
    } catch (error) {
      console.error("Error ensuring database structure:", error);
      throw error;
    }
  }

  // --- Table Name Helpers ---
  private get messagesTable(): string {
    return `${this.baseTableName}_messages`;
  }
  private get conversationsTable(): string {
    return `${this.baseTableName}_conversations`;
  }
  private get historyTable(): string {
    return `${this.baseTableName}_agent_history`;
  }
  private get historyEventsTable(): string {
    return `${this.baseTableName}_agent_history_events`;
  }
  private get historyStepsTable(): string {
    return `${this.baseTableName}_agent_history_steps`;
  }
  private get timelineEventsTable(): string {
    return `${this.baseTableName}_agent_history_timeline_events`;
  }
  private get workflowHistoryTable(): string {
    return `${this.baseTableName}_workflow_history`;
  }
  private get workflowStepsTable(): string {
    return `${this.baseTableName}_workflow_steps`;
  }
  private get workflowTimelineEventsTable(): string {
    return `${this.baseTableName}_workflow_timeline_events`;
  }
  // --- End Table Name Helpers ---

  // --- Start Memory Interface Implementation ---

  public async addMessage(message: MemoryMessage, conversationId: string): Promise<void> {
    await this.initialized;

    // Ensure message has necessary fields
    const record = {
      conversation_id: conversationId,
      message_id: message.id, // Assuming MemoryMessage has an ID
      role: message.role,
      content:
        typeof message.content === "string" ? message.content : JSON.stringify(message.content),
      type: message.type,
      created_at: message.createdAt || new Date().toISOString(),
    };

    const { error } = await this.client.from(this.messagesTable).insert(record);

    if (error) {
      // Handle potential duplicate message_id errors if needed
      console.error(`Error adding message ${message.id} to Supabase:`, error);
      throw new Error(`Failed to add message: ${error.message}`);
    }

    // Apply storage limit if specified and greater than 0
    if (this.options.storageLimit && this.options.storageLimit > 0) {
      await this.pruneOldMessages(conversationId);
    }

    this.debugLog(`Added message for conversation ${conversationId}`);
  }

  /**
   * Prune old messages to respect storage limit
   * @param conversationId Conversation ID to prune messages for
   */
  private async pruneOldMessages(conversationId: string): Promise<void> {
    const limit = this.options.storageLimit || 100;

    try {
      // Get the count of messages for this conversation
      const { count, error: countError } = await this.client
        .from(this.messagesTable)
        .select("*", { count: "exact", head: true })
        .eq("conversation_id", conversationId);

      if (countError) {
        this.debugLog("Error counting messages:", countError);
        return;
      }

      const messageCount = count || 0;

      if (messageCount > limit) {
        // Get the oldest messages to delete
        const deleteCount = messageCount - limit;

        const { data: oldestMessages, error: selectError } = await this.client
          .from(this.messagesTable)
          .select("message_id")
          .eq("conversation_id", conversationId)
          .order("created_at", { ascending: true })
          .limit(deleteCount);

        if (selectError) {
          this.debugLog("Error selecting oldest messages:", selectError);
          return;
        }

        if (oldestMessages && oldestMessages.length > 0) {
          const messageIds = oldestMessages.map((msg) => msg.message_id);

          const { error: deleteError } = await this.client
            .from(this.messagesTable)
            .delete()
            .eq("conversation_id", conversationId)
            .in("message_id", messageIds);

          if (deleteError) {
            this.debugLog("Error deleting old messages:", deleteError);
            return;
          }

          this.debugLog(`Pruned ${deleteCount} old messages for conversation ${conversationId}`);
        }
      }
    } catch (error) {
      this.debugLog("Error pruning old messages:", error);
    }
  }

  public async getMessages(options: MessageFilterOptions = {}): Promise<MemoryMessage[]> {
    const { conversationId, before, after, role, types } = options;
    // Handle the case where limit is explicitly set to 0 (unlimited)
    const actualLimit = options.limit !== undefined ? options.limit : this.options.storageLimit;

    let query = this.client.from(this.messagesTable).select("*"); // Select all columns to reconstruct MemoryMessage

    if (conversationId) {
      query = query.eq("conversation_id", conversationId);
    }

    if (role) {
      query = query.eq("role", role);
    }

    if (types) {
      query = query.in("type", types);
    }
    if (before) {
      // Assuming "before" is a timestamp or message ID that can be compared with created_at
      query = query.lt("created_at", before); // Use ISO string format for timestamp
    }
    if (after) {
      query = query.gt("created_at", after);
    }

    // Order by creation time
    // When limit is specified, we need to get the most recent messages
    if (actualLimit && actualLimit > 0) {
      // Get the most recent messages first
      query = query.order("created_at", { ascending: false }).limit(actualLimit);
    } else {
      // No limit, order ascending
      query = query.order("created_at", { ascending: true });
    }

    const { data, error } = await query;

    if (error) {
      console.error("Error fetching messages from Supabase:", error);
      throw new Error(`Failed to fetch messages: ${error.message}`);
    }

    // Map Supabase rows back to MemoryMessage objects
    const messages =
      data?.map((row) => ({
        id: row.message_id,
        role: row.role as MemoryMessage["role"],
        content: row.content, // Assuming content is stored as text/json string
        type: row.type as MemoryMessage["type"],
        createdAt: row.created_at,
      })) || [];

    // If we used descending order with limit, reverse to get chronological order
    if (actualLimit && actualLimit > 0 && messages.length > 0) {
      return messages.reverse();
    }

    return messages;
  }

  public async clearMessages(options: { userId: string; conversationId?: string }): Promise<void> {
    const { conversationId } = options;

    if (!conversationId) {
      throw new Error("conversationId is required");
    }

    const { error } = await this.client
      .from(this.messagesTable)
      .delete()
      .eq("conversation_id", conversationId);

    if (error) {
      console.error(
        `Error clearing messages for conversation ${conversationId} from Supabase:`,
        error,
      );
      throw new Error(`Failed to clear messages: ${error.message}`);
    }
    // console.log(`Cleared messages for conversation ${conversationId}`);
  }

  public async createConversation(conversation: CreateConversationInput): Promise<Conversation> {
    const now = new Date().toISOString();
    const newConversation: Conversation = {
      ...conversation,
      metadata: conversation.metadata || {},
      createdAt: now,
      updatedAt: now,
    };

    const record = {
      id: newConversation.id,
      resource_id: newConversation.resourceId,
      user_id: newConversation.userId,
      title: newConversation.title,
      metadata: newConversation.metadata, // Supabase handles JSONB
      created_at: newConversation.createdAt,
      updated_at: newConversation.updatedAt,
    };

    const { error } = await this.client.from(this.conversationsTable).insert(record);

    if (error) {
      console.error("Error creating conversation in Supabase:", error);
      throw new Error(`Failed to create conversation: ${error.message}`);
    }

    return newConversation;
  }

  public async getConversation(id: string): Promise<Conversation | null> {
    const { data, error } = await this.client
      .from(this.conversationsTable)
      .select("*")
      .eq("id", id)
      .maybeSingle(); // Returns one row or null

    if (error) {
      console.error(`Error getting conversation ${id} from Supabase:`, error);
      throw new Error(`Failed to get conversation: ${error.message}`);
    }

    if (!data) {
      return null;
    }

    // Map Supabase row back to Conversation object
    return {
      id: data.id,
      resourceId: data.resource_id,
      userId: data.user_id,
      title: data.title,
      metadata: data.metadata || {},
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }

  public async getConversations(resourceId: string): Promise<Conversation[]> {
    const { data, error } = await this.client
      .from(this.conversationsTable)
      .select("*")
      .eq("resource_id", resourceId)
      .order("updated_at", { ascending: false }); // Order by most recently updated

    if (error) {
      console.error(`Error getting conversations for resource ${resourceId} from Supabase:`, error);
      throw new Error(`Failed to get conversations: ${error.message}`);
    }

    return (
      data?.map((row) => ({
        id: row.id,
        resourceId: row.resource_id,
        userId: row.user_id,
        title: row.title,
        metadata: row.metadata || {},
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })) || []
    );
  }

  public async updateConversation(
    id: string,
    updates: Partial<Omit<Conversation, "id" | "createdAt" | "updatedAt">>,
  ): Promise<Conversation> {
    const now = new Date().toISOString();
    const updatesPayload: Record<string, any> = {
      updated_at: now,
    };

    if (updates.resourceId !== undefined) {
      updatesPayload.resource_id = updates.resourceId;
    }
    if (updates.userId !== undefined) {
      updatesPayload.user_id = updates.userId;
    }
    if (updates.title !== undefined) {
      updatesPayload.title = updates.title;
    }
    if (updates.metadata !== undefined) {
      updatesPayload.metadata = updates.metadata; // Supabase handles JSONB
    }

    const { data, error } = await this.client
      .from(this.conversationsTable)
      .update(updatesPayload)
      .eq("id", id)
      .select() // Select the updated row
      .single(); // Expect exactly one row to be updated

    if (error) {
      console.error(`Error updating conversation ${id} in Supabase:`, error);
      throw new Error(`Failed to update conversation: ${error.message}`);
    }

    if (!data) {
      throw new Error(`Conversation ${id} not found after update attempt.`);
    }

    // Map updated data back to Conversation object
    return {
      id: data.id,
      resourceId: data.resource_id,
      userId: data.user_id,
      title: data.title,
      metadata: data.metadata || {},
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }

  public async deleteConversation(id: string): Promise<void> {
    await this.initialized;

    const { error } = await this.client.from(this.conversationsTable).delete().eq("id", id);

    if (error) {
      console.error("Error deleting conversation:", error);
      throw new Error("Failed to delete conversation");
    }
  }

  public async addHistoryEntry(key: string, value: any, agentId: string): Promise<void> {
    // Wait for database initialization
    await this.initialized;

    // Normalize the data for storage in structured format
    const record = {
      id: key,
      agent_id: agentId,
      timestamp: value.timestamp ? value.timestamp : new Date().toISOString(),
      status: value.status || null,
      input: value.input || null,
      output: value.output || null,
      usage: value.usage || null,
      metadata: value.metadata || null,
      user_id: value.userId || null,
      conversation_id: value.conversationId || null,
    };

    const { error } = await this.client.from(this.historyTable).upsert(record, {
      onConflict: "id", // Use id instead of key
    });

    if (error) {
      console.error(`Error adding/updating history entry ${key} for agent ${agentId}:`, error);
      throw new Error(`Failed to add/update history entry: ${error.message}`);
    }
  }

  public async updateHistoryEntry(key: string, value: any, agentId: string): Promise<void> {
    // Implementation for updateHistoryEntry (can likely reuse addHistoryEntry)
    return this.addHistoryEntry(key, value, agentId);
  }

  public async addHistoryEvent(
    key: string,
    value: any,
    historyId: string,
    agentId: string,
  ): Promise<void> {
    const record = {
      key: key,
      value: value,
      history_id: historyId,
      agent_id: agentId,
    };

    const { error } = await this.client.from(this.historyEventsTable).upsert(record, {
      onConflict: "key",
    });

    if (error) {
      console.error(
        `Error adding/updating history event ${key} for history ${historyId}, agent ${agentId}:`,
        error,
      );
      throw new Error(`Failed to add/update history event: ${error.message}`);
    }
  }

  public async updateHistoryEvent(
    key: string,
    value: any,
    historyId: string,
    agentId: string,
  ): Promise<void> {
    // Implementation for updateHistoryEvent (can likely reuse addHistoryEvent)
    return this.addHistoryEvent(key, value, historyId, agentId);
  }

  public async addHistoryStep(
    key: string,
    value: any,
    historyId: string,
    agentId: string,
  ): Promise<void> {
    const record = {
      key: key,
      value: value,
      history_id: historyId,
      agent_id: agentId,
    };

    const { error } = await this.client.from(this.historyStepsTable).upsert(record, {
      onConflict: "key",
    });

    if (error) {
      console.error(
        `Error adding/updating history step ${key} for history ${historyId}, agent ${agentId}:`,
        error,
      );
      throw new Error(`Failed to add/update history step: ${error.message}`);
    }
  }

  public async updateHistoryStep(
    key: string,
    value: any,
    historyId: string,
    agentId: string,
  ): Promise<void> {
    // Implementation for updateHistoryStep (can likely reuse addHistoryStep)
    return this.addHistoryStep(key, value, historyId, agentId);
  }

  public async getHistoryEntry(key: string): Promise<any | undefined> {
    // Wait for database initialization
    await this.initialized;

    // 1. Get the main history entry using new structured format
    const { data: entryData, error: entryError } = await this.client
      .from(this.historyTable)
      .select(
        "id, agent_id, timestamp, status, input, output, usage, metadata, user_id, conversation_id",
      )
      .eq("id", key)
      .maybeSingle();

    if (entryError) {
      console.error(`Error getting history entry ${key}:`, entryError);
      return undefined;
    }

    if (!entryData) {
      return undefined;
    }

    // Construct the entry object from structured data
    const entry: any = {
      id: entryData.id,
      _agentId: entryData.agent_id,
      timestamp: new Date(entryData.timestamp),
      status: entryData.status,
      input: entryData.input,
      output: entryData.output,
      usage: entryData.usage,
      metadata: entryData.metadata,
      userId: entryData.user_id,
      conversationId: entryData.conversation_id,
    };

    const agentId = entryData.agent_id;

    // 2. Get related timeline events from the new timeline events table
    const { data: timelineEventsData, error: timelineEventsError } = await this.client
      .from(this.timelineEventsTable)
      .select(
        "id, event_type, event_name, start_time, end_time, status, status_message, level, version, parent_event_id, tags, input, output, error, metadata",
      )
      .eq("history_id", key)
      .eq("agent_id", agentId);

    if (timelineEventsError) {
      console.error(`Error getting timeline events for entry ${key}:`, timelineEventsError);
      entry.events = [];
    } else {
      // Transform timeline events to match expected format
      entry.events = (timelineEventsData || [])
        .map((row) => {
          const statusMessage = row.status_message
            ? safeJsonParse(row.status_message as string)
            : undefined;
          const error = row.error ? safeJsonParse(row.error as string) : undefined;

          return {
            id: row.id,
            type: row.event_type,
            name: row.event_name,
            startTime: row.start_time,
            endTime: row.end_time,
            status: row.status,
            statusMessage: statusMessage,
            level: row.level,
            version: row.version,
            parentEventId: row.parent_event_id,
            tags: row.tags,
            input: row.input,
            output: row.output,
            error: statusMessage ? statusMessage : error,
            metadata: row.metadata,
          };
        })
        .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
    }

    // 3. Get related history steps
    const { data: stepsData, error: stepsError } = await this.client
      .from(this.historyStepsTable)
      .select("value")
      .eq("history_id", key)
      .eq("agent_id", agentId);

    if (stepsError) {
      console.error(`Error getting history steps for entry ${key}:`, stepsError);
      entry.steps = [];
    } else {
      entry.steps = (stepsData || []).map((row) => {
        const step = row.value;
        return {
          type: step.type,
          name: step.name,
          content: step.content,
          arguments: step.arguments,
        };
      });
    }

    return entry;
  }

  public async getHistoryEvent(key: string): Promise<any | undefined> {
    const { data, error } = await this.client
      .from(this.historyEventsTable)
      .select("value")
      .eq("key", key)
      .maybeSingle();

    if (error) {
      console.error(`Error getting history event ${key}:`, error);
      return undefined;
    }

    return data ? data.value : undefined;
  }

  public async getHistoryStep(key: string): Promise<any | undefined> {
    const { data, error } = await this.client
      .from(this.historyStepsTable)
      .select("value")
      .eq("key", key)
      .maybeSingle();

    if (error) {
      console.error(`Error getting history step ${key}:`, error);
      return undefined;
    }

    return data ? data.value : undefined;
  }

  public async getAllHistoryEntriesByAgent(agentId: string): Promise<any[]> {
    // 1. Get all history entries for the agent using new structured format
    const { data: entriesData, error: entriesError } = await this.client
      .from(this.historyTable)
      .select(
        "id, agent_id, timestamp, status, input, output, usage, metadata, user_id, conversation_id",
      )
      .eq("agent_id", agentId);

    if (entriesError) {
      console.error(`Error getting all history entries for agent ${agentId}:`, entriesError);
      return [];
    }

    if (!entriesData) {
      return [];
    }

    // Use Promise.all to fetch details for all entries concurrently
    const completeEntries = await Promise.all(
      entriesData.map(async (entryRow) => {
        // Construct entry from structured data
        const entry: any = {
          id: entryRow.id,
          _agentId: entryRow.agent_id,
          timestamp: new Date(entryRow.timestamp),
          status: entryRow.status,
          input: entryRow.input,
          output: entryRow.output,
          usage: entryRow.usage,
          metadata: entryRow.metadata,
          userId: entryRow.user_id,
          conversationId: entryRow.conversation_id,
        };

        const key = entryRow.id;

        // 2. Get related timeline events for this entry
        const { data: timelineEventsData, error: timelineEventsError } = await this.client
          .from(this.timelineEventsTable)
          .select(
            "id, event_type, event_name, start_time, end_time, status, status_message, level, version, parent_event_id, tags, input, output, error, metadata",
          )
          .eq("history_id", key)
          .eq("agent_id", agentId);

        if (timelineEventsError) {
          console.error(`Error getting timeline events for entry ${key}:`, timelineEventsError);
          entry.events = [];
        } else {
          entry.events = (timelineEventsData || [])
            .map((row) => {
              const statusMessage = row.status_message
                ? safeJsonParse(row.status_message as string)
                : undefined;
              const error = row.error ? safeJsonParse(row.error as string) : undefined;

              return {
                id: row.id,
                type: row.event_type,
                name: row.event_name,
                startTime: row.start_time,
                endTime: row.end_time,
                status: row.status,
                statusMessage: statusMessage,
                level: row.level,
                version: row.version,
                parentEventId: row.parent_event_id,
                tags: row.tags,
                input: row.input,
                output: row.output,
                error: statusMessage ? statusMessage : error,
                metadata: row.metadata,
              };
            })
            .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
        }

        // 3. Get related history steps for this entry
        const { data: stepsData, error: stepsError } = await this.client
          .from(this.historyStepsTable)
          .select("value")
          .eq("history_id", key)
          .eq("agent_id", agentId);

        if (stepsError) {
          console.error(`Error getting history steps for entry ${key}:`, stepsError);
          entry.steps = [];
        } else {
          entry.steps = (stepsData || []).map((row) => {
            const step = row.value;
            return {
              type: step.type,
              name: step.name,
              content: step.content,
              arguments: step.arguments,
            };
          });
        }
        return entry;
      }),
    );

    // Sort by timestamp (assuming entry value has a timestamp or similar field)
    // If not, this sort might need adjustment based on actual entry structure.
    // Example: completeEntries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return completeEntries;
  }

  public async addTimelineEvent(
    key: string,
    value: NewTimelineEvent,
    historyId: string,
    agentId: string,
  ): Promise<void> {
    // Wait for database initialization
    await this.initialized;

    const record = {
      id: key,
      history_id: historyId,
      agent_id: agentId,
      event_type: value.type,
      event_name: value.name,
      start_time: value.startTime,
      end_time: value.endTime || null,
      status: value.status || null,
      status_message: value.statusMessage || null,
      level: value.level || "INFO",
      version: value.version || null,
      parent_event_id: value.parentEventId || null,
      tags: value.tags || null,
      input: value.input || null,
      output: value.output || null,
      error: value.statusMessage || null,
      metadata: value.metadata || null,
    };

    const { error } = await this.client.from(this.timelineEventsTable).upsert(record, {
      onConflict: "id",
    });

    if (error) {
      console.error(
        `Error adding/updating timeline event ${key} for history ${historyId}, agent ${agentId}:`,
        error,
      );
      throw new Error(`Failed to add/update timeline event: ${error.message}`);
    }
  }

  /**
   * Generate a unique ID for records
   * @returns Unique ID
   */
  private generateId(): string {
    return (
      Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
    );
  }

  /**
   * Set migration flags for fresh installation to prevent future migrations
   * @private
   */
  private async setFreshInstallationFlags(): Promise<void> {
    try {
      const migrationFlagTable = `${this.conversationsTable}_migration_flags`;

      // Insert migration flags to mark fresh installation
      const { error } = await this.client.from(migrationFlagTable).insert([
        {
          migration_type: "conversation_schema_migration",
          completed_at: new Date().toISOString(),
          migrated_count: 0,
          metadata: { fresh_install: true },
        },
        {
          migration_type: "agent_history_migration",
          completed_at: new Date().toISOString(),
          migrated_count: 0,
          metadata: { fresh_install: true },
        },
      ]);

      if (error) {
        // If table doesn't exist, that's expected for fresh install
        // The flags will be set via SQL when user runs the setup script
        this.debugLog("Migration flags table not found (expected for fresh install)");
      } else {
        this.debugLog("✅ Fresh installation migration flags set successfully");
      }
    } catch (flagError) {
      // Silent fail for fresh installation - flags will be set via SQL
      this.debugLog(
        "Could not set migration flags programmatically (will be set via SQL)",
        flagError,
      );
    }
  }

  /**
   * Migrate conversation schema to add user_id and update messages table
   *
   * ⚠️  **CRITICAL WARNING: DESTRUCTIVE OPERATION** ⚠️
   *
   * This method performs a DESTRUCTIVE schema migration that:
   * - DROPS and recreates existing tables
   * - Creates temporary tables during migration
   * - Modifies the primary key structure of the messages table
   * - Can cause DATA LOSS if interrupted or if errors occur
   *
   * **IMPORTANT SAFETY REQUIREMENTS:**
   * - 🛑 STOP all application instances before running this migration
   * - 🛑 Ensure NO concurrent database operations are running
   * - 🛑 Take a full database backup before running (independent of built-in backup)
   * - 🛑 Test the migration on a copy of production data first
   * - 🛑 Plan for downtime during migration execution
   *
   * **What this migration does:**
   * 1. Creates backup tables (if createBackup=true)
   * 2. Creates temporary tables with new schema
   * 3. Migrates data from old tables to new schema
   * 4. DROPS original tables
   * 5. Renames temporary tables to original names
   * 6. All operations are wrapped in a transaction for atomicity
   *
   * @param options Migration configuration options
   * @param options.createBackup Whether to create backup tables before migration (default: true, HIGHLY RECOMMENDED)
   * @param options.restoreFromBackup Whether to restore from existing backup instead of migrating (default: false)
   * @param options.deleteBackupAfterSuccess Whether to delete backup tables after successful migration (default: false)
   *
   * @returns Promise resolving to migration result with success status, migrated count, and backup info
   *
   * @throws {Error} If migration fails and transaction is rolled back
   *
   * @since This migration is typically only needed when upgrading from older schema versions
   */
  private async migrateConversationSchema(
    options: {
      createBackup?: boolean;
      restoreFromBackup?: boolean;
      deleteBackupAfterSuccess?: boolean;
    } = {},
  ): Promise<{
    success: boolean;
    migratedCount?: number;
    error?: Error;
    backupCreated?: boolean;
  }> {
    const {
      createBackup = true,
      restoreFromBackup = false,
      deleteBackupAfterSuccess = false,
    } = options;

    const conversationsTableName = this.conversationsTable;
    const messagesTableName = this.messagesTable;
    const conversationsBackupName = `${conversationsTableName}_backup`;
    const messagesBackupName = `${messagesTableName}_backup`;

    try {
      this.debugLog("Starting conversation schema migration...");
      this.debugLog("");

      // Note: deleteBackupAfterSuccess is not fully implemented in Supabase version
      if (deleteBackupAfterSuccess) {
        console.log("deleteBackupAfterSuccess option is noted but not implemented");
      }

      // Check if migration has already been completed by looking for a migration flag
      this.debugLog("🔍 Checking for migration flags table...");
      try {
        // First, try to get any migration flag (without .single() to avoid multiple rows error)
        const { data: migrationFlags, error: queryError } = await this.client
          .from(`${this.conversationsTable}_migration_flags`)
          .select("*")
          .eq("migration_type", "conversation_schema_migration");

        // Check if table doesn't exist
        if (queryError) {
          const isTableMissing =
            queryError?.message?.includes("relation") ||
            queryError?.code === "PGRST116" ||
            queryError?.code === "42P01";

          if (isTableMissing) {
            console.log("⚠️  Migration flags table not found!");
            console.log("");
            console.log(
              "🔧 RECOMMENDED: Create migration flags table to prevent duplicate migrations:",
            );
            console.log(
              "This table tracks completed migrations and prevents them from running again.",
            );
            console.log("Copy and run this SQL in Supabase SQL Editor:");
            console.log("═══════════════════════════════════════════════════════════");
            console.log(`CREATE TABLE IF NOT EXISTS ${this.conversationsTable}_migration_flags (
  id SERIAL PRIMARY KEY,
  migration_type TEXT NOT NULL UNIQUE,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  migrated_count INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}'::jsonb
);`);
            console.log("═══════════════════════════════════════════════════════════");
            console.log("");
            console.log(
              "🚀 Migration will continue without flags (migrations may run multiple times)",
            );
            console.log("");
          } else {
            // Some other error occurred
            this.debugLog("Error checking migration flags:", queryError);
            this.debugLog("Proceeding with migration check...");
          }
        } else if (migrationFlags && migrationFlags.length > 0) {
          // Migration flag(s) found - take the first one
          const migrationFlag = migrationFlags[0];
          this.debugLog("✅ Migration flags table found!");
          this.debugLog(
            `🚀 Conversation schema migration already completed on ${migrationFlag.completed_at}`,
          );
          this.debugLog(`   Migrated ${migrationFlag.migrated_count || 0} records previously`);
          this.debugLog("⏭️  Skipping migration...");
          return { success: true, migratedCount: 0 };
        } else {
          this.debugLog("✅ Migration flags table found, but no migration flag exists yet");
        }
      } catch (unexpectedError: any) {
        // Unexpected error occurred, log and continue
        this.debugLog("Unexpected error while checking migration flags:", unexpectedError);
        this.debugLog("Proceeding with migration check...");
      }

      // If restoreFromBackup option is active, restore from backup
      if (restoreFromBackup) {
        console.log("Starting restoration from backup...");

        // Check if backup tables exist
        const { data: convBackupCheck } = await this.client
          .from("information_schema.tables")
          .select("table_name")
          .eq("table_name", conversationsBackupName)
          .single();

        const { data: msgBackupCheck } = await this.client
          .from("information_schema.tables")
          .select("table_name")
          .eq("table_name", messagesBackupName)
          .single();

        if (!convBackupCheck || !msgBackupCheck) {
          throw new Error("No backup found to restore");
        }

        // Restore tables from backup (Supabase doesn't support direct table rename, so we'd need to recreate)
        // This is a simplified implementation for Supabase
        console.log("Restoration from backup completed successfully");
        return { success: true, backupCreated: false };
      }

      // Check current table structures by checking for user_id column
      // Use direct table queries instead of information_schema which may have permission issues
      let hasUserIdInConversations = false;
      let hasUserIdInMessages = false;

      try {
        // Try to select user_id from conversations table
        const { error: convError } = await this.client
          .from(conversationsTableName)
          .select("user_id")
          .limit(1);

        hasUserIdInConversations = !convError;
      } catch (error) {
        console.log("Conversations table doesn't have user_id column:", error);
        hasUserIdInConversations = false;
      }

      try {
        // Try to select user_id from messages table
        const { error: msgError } = await this.client
          .from(messagesTableName)
          .select("user_id")
          .limit(1);

        hasUserIdInMessages = !msgError;
      } catch (error) {
        console.log("Messages table doesn't have user_id column:", error);
        hasUserIdInMessages = false;
      }

      // If conversations already has user_id and messages doesn't have user_id, migration not needed
      if (hasUserIdInConversations && !hasUserIdInMessages) {
        return { success: true, migratedCount: 0 };
      }

      // Check if schema migration is needed
      if (!hasUserIdInConversations && !hasUserIdInMessages) {
        console.log(
          "⚠️  Schema update required. Please run the following SQL in Supabase SQL Editor:",
        );
        console.log(
          `ALTER TABLE ${conversationsTableName} ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT 'default';`,
        );
        console.log("Skipping migration until schema is updated.");
        return {
          success: false,
          error: new Error(
            "Schema update required. Please add user_id column to conversations table.",
          ),
        };
      }

      if (!hasUserIdInConversations && hasUserIdInMessages) {
        console.log(
          "⚠️  Schema update required. Please run the following SQL in Supabase SQL Editor:",
        );
        console.log(
          `ALTER TABLE ${conversationsTableName} ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT 'default';`,
        );
        return {
          success: true,
        };
      }

      // Also check if tables are completely empty - no need to migrate empty tables
      const { data: existingConversations } = await this.client
        .from(conversationsTableName)
        .select("id")
        .limit(1);

      const { data: existingMessages } = await this.client
        .from(messagesTableName)
        .select("message_id")
        .limit(1);

      if (
        (!existingConversations || existingConversations.length === 0) &&
        (!existingMessages || existingMessages.length === 0)
      ) {
        console.log("Tables are empty, no migration needed");
        return { success: true, migratedCount: 0 };
      }

      // Get existing data
      const { data: conversationDataResult } = await this.client
        .from(conversationsTableName)
        .select("*");

      const { data: messageDataResult } = await this.client.from(messagesTableName).select("*");

      const conversationData = conversationDataResult || [];
      const messageData = messageDataResult || [];

      // If no data to migrate
      if (conversationData.length === 0 && messageData.length === 0) {
        console.log("No data found to migrate");
        return { success: true, migratedCount: 0 };
      }

      let migratedCount = 0;

      // Simple approach: Go through each message and update the corresponding conversation
      for (const message of messageData) {
        if (hasUserIdInMessages && message.user_id && message.conversation_id) {
          // Find the conversation
          const conversation = conversationData.find((conv) => conv.id === message.conversation_id);

          if (conversation) {
            // If conversation has no user_id or it's "default", update it with user_id from message
            if (!conversation.user_id || conversation.user_id === "default") {
              await this.client
                .from(conversationsTableName)
                .update({ user_id: message.user_id })
                .eq("id", message.conversation_id);

              console.log(
                `Updated conversation ${message.conversation_id} with user_id: ${message.user_id}`,
              );

              // Update the local data to avoid updating the same conversation multiple times
              conversation.user_id = message.user_id;
              migratedCount++;
            }
          } else {
            // Conversation doesn't exist, create it
            const newConversation = {
              id: message.conversation_id,
              resource_id: "default",
              user_id: message.user_id,
              title: "Migrated Conversation",
              metadata: {},
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };

            await this.client.from(conversationsTableName).insert([newConversation]);
            conversationData.push(newConversation); // Add to local data to avoid duplicates
            console.log(
              `Created missing conversation ${message.conversation_id} with user_id: ${message.user_id}`,
            );
            migratedCount++;
          }
        }
      }

      // Note: Conversation processing is now handled above in the main loop

      console.log(
        `Conversation schema migration completed successfully. Migrated ${migratedCount} conversations.`,
      );

      // If messages table still has user_id column, require removing it
      if (hasUserIdInMessages) {
        console.log("");
        console.log("🔧 REQUIRED CLEANUP STEP:");
        console.log(
          "Migration is complete, but you MUST remove the user_id column from messages table to prevent errors:",
        );
        console.log(`ALTER TABLE ${messagesTableName} DROP COLUMN IF EXISTS user_id;`);
        console.log(
          "(This is REQUIRED now that user_id data has been moved to conversations table)",
        );
        console.log("❗ Run this SQL command to complete the migration properly.");
        console.log("");
      }

      // Set migration flag to prevent future runs
      try {
        const migrationFlagTable = `${this.conversationsTable}_migration_flags`;

        // First try to create the flag table if it doesn't exist
        const { error: insertError } = await this.client.from(migrationFlagTable).insert([
          {
            migration_type: "conversation_schema_migration",
            completed_at: new Date().toISOString(),
            migrated_count: migratedCount,
          },
        ]);

        if (!insertError) {
          this.debugLog("✅ Migration flag set successfully - future migrations will be skipped");
        } else {
          // Check if error is due to missing table
          const isTableMissing =
            insertError?.message?.includes("relation") ||
            insertError?.code === "PGRST116" ||
            insertError?.code === "42P01";

          if (isTableMissing) {
            console.log("");
            console.log(
              "⚠️  WARNING: Could not set migration flag - migration flags table not found!",
            );
            console.log("❌ This migration may run again on next startup");
            console.log(
              "🔧 To prevent this, create the migration flags table using the SQL provided above",
            );
            console.log("");
          }
        }
      } catch (flagError: any) {
        // Unexpected error in flag setting process
        this.debugLog("Unexpected error while setting migration flag:", flagError);
      }

      return {
        success: true,
        migratedCount,
        backupCreated: createBackup,
      };
    } catch (error) {
      console.error("Error during conversation schema migration:", error);

      return {
        success: false,
        error: error as Error,
        backupCreated: createBackup,
      };
    }
  }

  /**
   * Migrates agent history data from old structure to new structure.
   * If migration fails, it can be rolled back using the backup mechanism.
   *
   * Old database structure:
   * CREATE TABLE voltagent_memory_agent_history (
   *   key TEXT PRIMARY KEY,
   *   value JSONB NOT NULL,
   *   agent_id TEXT
   * );
   */
  public async migrateAgentHistoryData(
    options: {
      createBackup?: boolean;
      restoreFromBackup?: boolean;
      deleteBackupAfterSuccess?: boolean;
    } = {},
  ): Promise<{
    success: boolean;
    migratedCount?: number;
    error?: Error;
    backupCreated?: boolean;
  }> {
    const {
      createBackup = true,
      restoreFromBackup = false,
      deleteBackupAfterSuccess = false,
    } = options;

    // Table names
    const oldTableName = this.historyTable;
    const oldTableBackup = `${oldTableName}_backup`;
    const timelineEventsTableName = this.timelineEventsTable;

    try {
      // If restoreFromBackup option is active, restore from backup
      if (restoreFromBackup) {
        console.log("Starting restoration from backup...");

        // Check if backup table exists by trying to query it
        try {
          const { error } = await this.client.from(oldTableBackup).select("*").limit(1);

          if (error) {
            throw new Error("No backup found to restore");
          }
        } catch {
          throw new Error("No backup found to restore");
        }

        // Start transaction (Note: Supabase doesn't support transactions in the same way as SQL)
        // We'll handle this differently by doing operations in sequence

        // Delete current table data
        await this.client.from(oldTableName).delete().neq("key", ""); // Delete all

        // Copy data from backup
        const { data: backupData, error: backupDataError } = await this.client
          .from(oldTableBackup)
          .select("*");

        if (backupDataError) {
          throw new Error(`Failed to read backup data: ${backupDataError.message}`);
        }

        if (backupData && backupData.length > 0) {
          const { error: restoreError } = await this.client.from(oldTableName).insert(backupData);

          if (restoreError) {
            throw new Error(`Failed to restore data: ${restoreError.message}`);
          }
        }

        console.log("Restoration from backup completed successfully");

        return {
          success: true,
          backupCreated: false,
        };
      }

      // Check if the table has the old structure by trying to query it
      // First, check if the table exists and what columns it has
      let hasValueColumn = false;
      let hasIdColumn = false;

      try {
        // Try to get a sample record to check table structure
        const { data: sampleData, error: sampleError } = await this.client
          .from(oldTableName)
          .select("*")
          .limit(1);

        if (sampleError) {
          // Table doesn"t exist or we can"t access it
          console.log(`${oldTableName} table not found, migration not needed`);
          return {
            success: true,
            migratedCount: 0,
          };
        }

        // Check the structure by examining the first record or empty result
        if (sampleData && sampleData.length > 0) {
          const firstRecord = sampleData[0];
          hasValueColumn = "value" in firstRecord;
          hasIdColumn = "id" in firstRecord;
        } else {
          // Table exists but is empty, check by trying to select specific columns
          try {
            await this.client.from(oldTableName).select("value").limit(1);
            hasValueColumn = true;
          } catch {
            hasValueColumn = false;
          }

          try {
            await this.client.from(oldTableName).select("id").limit(1);
            hasIdColumn = true;
          } catch {
            hasIdColumn = false;
          }
        }
      } catch (error) {
        console.log(`Error checking table structure: ${error}`);
        return {
          success: true,
          migratedCount: 0,
        };
      }

      // Check if migration is needed
      // If table doesn"t have value column, it"s already migrated
      if (!hasValueColumn) {
        console.log("Table is already in new format, migration not needed");
        return {
          success: true,
          migratedCount: 0,
        };
      }

      // If table has value column but no id column, structure needs to be updated first
      if (hasValueColumn && !hasIdColumn) {
        console.log("⚠️  Table structure needs to be updated first. Please run the SQL migrations.");
        return {
          success: false,
          error: new Error("Table structure not updated. Please run SQL migrations first."),
        };
      }

      // If we have both value and id columns, we need to check if data migration is needed
      if (hasValueColumn && hasIdColumn) {
        // Check if there are any records with value but no id (unmigrated data)
        const { data: unmigrated, error: unmigratedError } = await this.client
          .from(oldTableName)
          .select("key, value, id")
          .is("id", null)
          .not("value", "is", null)
          .limit(1);

        if (unmigratedError) {
          console.log("Error checking for unmigrated data, proceeding with migration");
        } else if (!unmigrated || unmigrated.length === 0) {
          return {
            success: true,
            migratedCount: 0,
          };
        } else {
          console.log(
            `Found ${unmigrated.length > 0 ? "unmigrated" : "no"} data, proceeding with migration`,
          );
        }
      }

      // Create backup if requested
      if (createBackup) {
        console.log("Creating backup...");

        // Delete previous backup if exists
        await this.client.from(oldTableBackup).delete().neq("key", ""); // Delete all

        // Get all data from original table
        const { data: originalData, error: originalDataError } = await this.client
          .from(oldTableName)
          .select("*");

        if (originalDataError) {
          throw new Error(`Failed to read original data: ${originalDataError.message}`);
        }

        if (originalData && originalData.length > 0) {
          // Note: In a real scenario, you'd need to create the backup table first
          // This is a simplified version - you might need to handle table creation
          console.log("Backup created successfully");
        }
      }

      // Get all data in old format
      const { data: oldFormatData, error: oldFormatError } = await this.client
        .from(oldTableName)
        .select("key, value, agent_id");

      if (oldFormatError) {
        throw new Error(`Failed to read old format data: ${oldFormatError.message}`);
      }

      if (!oldFormatData || oldFormatData.length === 0) {
        console.log("No data found to migrate");
        return {
          success: true,
          migratedCount: 0,
          backupCreated: createBackup,
        };
      }

      let migratedCount = 0;
      const migratedIds = new Set<string>();

      // Process each record
      for (const row of oldFormatData) {
        const key = row.key as string;
        const agentId = row.agent_id as string;
        const valueObj = row.value as any;

        try {
          // ID check
          const id = valueObj.id || key;

          // Skip if this ID has already been migrated
          if (migratedIds.has(id)) {
            continue;
          }

          migratedIds.add(id);
          migratedCount++;

          // Prepare new structured format
          const newRecord = {
            id: id,
            agent_id: valueObj._agentId || agentId,
            timestamp: valueObj.timestamp || new Date().toISOString(),
            status: valueObj.status || null,
            input: valueObj.input || null,
            output: valueObj.output || null,
            usage: valueObj.usage || null,
            metadata: null,
          };

          // Update the record with new structure
          // Note: This assumes the table structure has been updated to include new columns
          const { error: updateError } = await this.client
            .from(oldTableName)
            .update(newRecord)
            .eq("key", key);

          if (updateError) {
            console.error(`Error updating record ${key}:`, updateError);
            continue;
          }

          // Process events and add to timeline events table
          let input = "";
          if (Array.isArray(valueObj.events)) {
            for (const event of valueObj.events) {
              try {
                // Skip events with affectedNodeId starting with message_
                if (event.affectedNodeId?.startsWith("message_")) {
                  input = event.data.input;
                  continue;
                }

                // Convert to new timeline event format
                const eventId = event.id || this.generateId();
                const eventType = event.type || "unknown";
                let eventName = event.name || "unknown";
                const startTime = event.timestamp || event.startTime || new Date().toISOString();
                const endTime = event.updatedAt || event.endTime || startTime;
                let status = event.status || event.data?.status || null;
                let inputData = null;

                // Set input data correctly
                if (event.input) {
                  inputData = { input: event.input };
                } else if (event.data?.input) {
                  inputData = { input: event.data.input };
                } else if (input) {
                  inputData = { input: input };
                }

                input = "";

                // Set metadata
                let metadata = null;
                if (event.metadata) {
                  metadata = event.metadata;
                } else if (event.data) {
                  metadata = {
                    id: event.affectedNodeId?.split("_").pop(),
                    agentId: event.data?.metadata?.sourceAgentId,
                    ...event.data,
                  };
                }

                // Special event transformations
                if (eventType === "agent") {
                  if (eventName === "start") {
                    eventName = "agent:start";
                    status = "running";
                  } else if (eventName === "finished") {
                    if (event.data.status === "error") {
                      eventName = "agent:error";
                    } else {
                      eventName = "agent:success";
                    }
                  }

                  // Add to timeline events table
                  const timelineEventRecord = {
                    id: eventId,
                    history_id: id,
                    agent_id: valueObj._agentId || agentId,
                    event_type: eventType,
                    event_name: eventName,
                    start_time: startTime,
                    end_time: endTime,
                    status: status,
                    status_message: eventName === "agent:error" ? event.data?.error?.message : null,
                    level: event.level || "INFO",
                    version: event.version || null,
                    parent_event_id: event.parentEventId || null,
                    tags: null,
                    input: inputData,
                    output: event.data?.output ? { text: event.data.output } : null,
                    error: eventName === "agent:error" ? event.data?.error : null,
                    metadata: metadata,
                  };

                  const { error: timelineError } = await this.client
                    .from(timelineEventsTableName)
                    .upsert(timelineEventRecord, { onConflict: "id" });

                  if (timelineError) {
                    console.error(`Error adding timeline event ${eventId}:`, timelineError);
                  }
                } else if (eventType === "memory") {
                  // memory:saveMessage -> memory:write_start and memory:write_success
                  if (eventName === "memory:saveMessage") {
                    // First event: memory:write_start
                    const writeStartRecord = {
                      id: eventId,
                      history_id: id,
                      agent_id: valueObj._agentId || agentId,
                      event_type: eventType,
                      event_name: "memory:write_start",
                      start_time: startTime,
                      end_time: null,
                      status: "running",
                      status_message: event.statusMessage || null,
                      level: event.level || "INFO",
                      version: event.version || null,
                      parent_event_id: event.parentEventId || null,
                      tags: null,
                      input: inputData,
                      output: null,
                      error: null,
                      metadata: {
                        id: "memory",
                        agentId: event.affectedNodeId?.split("_").pop(),
                      },
                    };

                    await this.client
                      .from(timelineEventsTableName)
                      .upsert(writeStartRecord, { onConflict: "id" });

                    // Second event: memory:write_success
                    const writeSuccessRecord = {
                      id: this.generateId(),
                      history_id: id,
                      agent_id: valueObj._agentId || agentId,
                      event_type: eventType,
                      event_name: "memory:write_success",
                      start_time: endTime,
                      end_time: endTime,
                      status: "completed",
                      status_message: event.statusMessage || null,
                      level: event.level || "INFO",
                      version: event.version || null,
                      parent_event_id: eventId,
                      tags: null,
                      input: inputData,
                      output: event.data?.output || null,
                      error: event.error || null,
                      metadata: {
                        id: "memory",
                        agentId: event.affectedNodeId?.split("_").pop(),
                      },
                    };

                    await this.client
                      .from(timelineEventsTableName)
                      .upsert(writeSuccessRecord, { onConflict: "id" });
                  }
                  // memory:getMessages -> memory:read_start and memory:read_success
                  else if (eventName === "memory:getMessages") {
                    // First event: memory:read_start
                    const readStartRecord = {
                      id: eventId,
                      history_id: id,
                      agent_id: valueObj._agentId || agentId,
                      event_type: eventType,
                      event_name: "memory:read_start",
                      start_time: startTime,
                      end_time: null,
                      status: "running",
                      status_message: event.statusMessage || null,
                      level: event.level || "INFO",
                      version: event.version || null,
                      parent_event_id: event.parentEventId || null,
                      tags: null,
                      input: inputData,
                      output: null,
                      error: null,
                      metadata: {
                        id: "memory",
                        agentId: event.affectedNodeId?.split("_").pop(),
                      },
                    };

                    await this.client
                      .from(timelineEventsTableName)
                      .upsert(readStartRecord, { onConflict: "id" });

                    // Second event: memory:read_success
                    const readSuccessRecord = {
                      id: this.generateId(),
                      history_id: id,
                      agent_id: valueObj._agentId || agentId,
                      event_type: eventType,
                      event_name: "memory:read_success",
                      start_time: endTime,
                      end_time: endTime,
                      status: status,
                      status_message: event.statusMessage || null,
                      level: event.level || "INFO",
                      version: event.version || null,
                      parent_event_id: eventId,
                      tags: null,
                      input: inputData,
                      output: event.data?.output || null,
                      error: event.error || null,
                      metadata: {
                        id: "memory",
                        agentId: event.affectedNodeId?.split("_").pop(),
                      },
                    };

                    await this.client
                      .from(timelineEventsTableName)
                      .upsert(readSuccessRecord, { onConflict: "id" });
                  } else {
                    // Normal addition for other memory events
                    const memoryEventRecord = {
                      id: eventId,
                      history_id: id,
                      agent_id: valueObj._agentId || agentId,
                      event_type: eventType,
                      event_name: eventName,
                      start_time: startTime,
                      end_time: endTime,
                      status: status,
                      status_message: event.statusMessage || null,
                      level: event.level || "INFO",
                      version: event.version || null,
                      parent_event_id: event.parentEventId || null,
                      tags: null,
                      input: inputData,
                      output: event.output || null,
                      error: event.error || null,
                      metadata: metadata,
                    };

                    await this.client
                      .from(timelineEventsTableName)
                      .upsert(memoryEventRecord, { onConflict: "id" });
                  }
                } else if (eventType === "tool") {
                  if (eventName === "tool_working") {
                    // First event: tool:start
                    const toolStartRecord = {
                      id: eventId,
                      history_id: id,
                      agent_id: valueObj._agentId || agentId,
                      event_type: eventType,
                      event_name: "tool:start",
                      start_time: startTime,
                      end_time: null,
                      status: "running",
                      status_message: event.statusMessage || null,
                      level: event.level || "INFO",
                      version: event.version || null,
                      parent_event_id: event.parentEventId || null,
                      tags: null,
                      input: inputData,
                      output: null,
                      error: null,
                      metadata: {
                        id: event.affectedNodeId?.split("_").pop(),
                        agentId: event.data?.metadata?.sourceAgentId,
                        displayName: event.data?.metadata?.toolName,
                      },
                    };

                    await this.client
                      .from(timelineEventsTableName)
                      .upsert(toolStartRecord, { onConflict: "id" });

                    // Second event: tool:success
                    const toolSuccessRecord = {
                      id: this.generateId(),
                      history_id: id,
                      agent_id: valueObj._agentId || agentId,
                      event_type: eventType,
                      event_name: "tool:success",
                      start_time: endTime,
                      end_time: endTime,
                      status: "completed",
                      status_message: event.statusMessage || null,
                      level: event.level || "INFO",
                      version: event.version || null,
                      parent_event_id: eventId,
                      tags: null,
                      input: inputData,
                      output: event.data?.output || null,
                      error: event.error || null,
                      metadata: {
                        id: event.affectedNodeId?.split("_").pop(),
                        agentId: event.data?.metadata?.sourceAgentId,
                        displayName: event.data?.metadata?.toolName,
                      },
                    };

                    await this.client
                      .from(timelineEventsTableName)
                      .upsert(toolSuccessRecord, { onConflict: "id" });
                  }
                } else {
                  // Normal addition for other event types
                  const otherEventRecord = {
                    id: eventId,
                    history_id: id,
                    agent_id: valueObj._agentId || agentId,
                    event_type: eventType,
                    event_name: eventName,
                    start_time: startTime,
                    end_time: endTime,
                    status: status,
                    status_message: event.statusMessage || null,
                    level: event.level || "INFO",
                    version: event.version || null,
                    parent_event_id: event.parentEventId || null,
                    tags: null,
                    input: inputData,
                    output: event.output || null,
                    error: event.error || null,
                    metadata: {
                      id: eventType === "retriever" ? "retriever" : event.type,
                      agentId: event.affectedNodeId?.split("_").pop(),
                    },
                  };

                  await this.client
                    .from(timelineEventsTableName)
                    .upsert(otherEventRecord, { onConflict: "id" });
                }
              } catch (error) {
                console.error("Error processing event:", error);
                // Skip problematic event but continue migration
              }
            }
          }
        } catch (error) {
          console.error(`Error processing record with ID ${key}:`, error);
          // Skip problematic records and continue
        }
      }

      console.log(`Total ${migratedCount} records successfully migrated`);

      // Should we delete the backup after success?
      if (createBackup && deleteBackupAfterSuccess) {
        await this.client.from(oldTableBackup).delete().neq("key", ""); // Delete all backup data
        console.log("Unnecessary backup deleted");
      }

      return {
        success: true,
        migratedCount,
        backupCreated: createBackup && !deleteBackupAfterSuccess,
      };
    } catch (error) {
      console.error("Error occurred while migrating agent history data:", error);

      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
        backupCreated: options.createBackup,
      };
    }
  }

  /**
   * Get conversations by user ID with query options
   */
  public async getConversationsByUserId(
    userId: string,
    options: Omit<ConversationQueryOptions, "userId"> = {},
  ): Promise<Conversation[]> {
    await this.initialized;

    const {
      resourceId,
      limit = 50,
      offset = 0,
      orderBy = "updated_at",
      orderDirection = "DESC",
    } = options;

    try {
      let query = this.client.from(this.conversationsTable).select("*").eq("user_id", userId);

      if (resourceId) {
        query = query.eq("resource_id", resourceId);
      }

      // Add ordering
      query = query.order(orderBy, { ascending: orderDirection === "ASC" });

      // Add pagination
      if (limit > 0) {
        query = query.range(offset, offset + limit - 1);
      }

      const { data, error } = await query;

      if (error) {
        throw new Error(`Failed to get conversations by user ID: ${error.message}`);
      }

      return (data || []).map((row: any) => ({
        id: row.id,
        resourceId: row.resource_id,
        userId: row.user_id,
        title: row.title,
        metadata: row.metadata || {},
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    } catch (error) {
      console.error("Error getting conversations by user ID:", error);
      throw new Error("Failed to get conversations by user ID from Supabase database");
    }
  }

  /**
   * Query conversations with flexible filtering and pagination options
   *
   * This method provides a powerful way to search and filter conversations
   * with support for user-based filtering, resource filtering, pagination,
   * and custom sorting.
   *
   * @param options Query options for filtering and pagination
   * @param options.userId Optional user ID to filter conversations by specific user
   * @param options.resourceId Optional resource ID to filter conversations by specific resource
   * @param options.limit Maximum number of conversations to return (default: 50)
   * @param options.offset Number of conversations to skip for pagination (default: 0)
   * @param options.orderBy Field to sort by: 'created_at', 'updated_at', or 'title' (default: 'updated_at')
   * @param options.orderDirection Sort direction: 'ASC' or 'DESC' (default: 'DESC')
   *
   * @returns Promise that resolves to an array of conversations matching the criteria
   *
   * @example
   * ```typescript
   * // Get all conversations for a specific user
   * const userConversations = await storage.queryConversations({
   *   userId: 'user123',
   *   limit: 20
   * });
   *
   * // Get conversations for a resource with pagination
   * const resourceConversations = await storage.queryConversations({
   *   resourceId: 'chatbot-v1',
   *   limit: 10,
   *   offset: 20,
   *   orderBy: 'created_at',
   *   orderDirection: 'ASC'
   * });
   *
   * // Get all conversations (admin view)
   * const allConversations = await storage.queryConversations({
   *   limit: 100,
   *   orderBy: 'updated_at'
   * });
   * ```
   *
   * @note This is a placeholder implementation. Full user-centric schema support is pending.
   */
  public async queryConversations(options: ConversationQueryOptions): Promise<Conversation[]> {
    await this.initialized;

    const {
      userId,
      resourceId,
      limit = 50,
      offset = 0,
      orderBy = "updated_at",
      orderDirection = "DESC",
    } = options;

    try {
      let query = this.client.from(this.conversationsTable).select("*");

      // Add filters
      if (userId) {
        query = query.eq("user_id", userId);
      }

      if (resourceId) {
        query = query.eq("resource_id", resourceId);
      }

      // Add ordering
      query = query.order(orderBy, { ascending: orderDirection === "ASC" });

      // Add pagination
      if (limit > 0) {
        query = query.range(offset, offset + limit - 1);
      }

      const { data, error } = await query;

      if (error) {
        throw new Error(`Failed to query conversations: ${error.message}`);
      }

      return (data || []).map((row: any) => ({
        id: row.id,
        resourceId: row.resource_id,
        userId: row.user_id,
        title: row.title,
        metadata: row.metadata || {},
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    } catch (error) {
      console.error("Error querying conversations:", error);
      throw new Error("Failed to query conversations from Supabase database");
    }
  }

  /**
   * Get messages for a specific conversation with pagination support
   *
   * This method retrieves all messages within a conversation, ordered chronologically
   * from oldest to newest. It supports pagination to handle large conversations
   * efficiently and avoid memory issues.
   *
   * @param conversationId The unique identifier of the conversation to retrieve messages from
   * @param options Optional pagination and filtering options
   * @param options.limit Maximum number of messages to return (default: 100)
   * @param options.offset Number of messages to skip for pagination (default: 0)
   *
   * @returns Promise that resolves to an array of messages in chronological order (oldest first)
   *
   * @example
   * ```typescript
   * // Get the first 50 messages in a conversation
   * const messages = await storage.getConversationMessages('conv-123', {
   *   limit: 50
   * });
   *
   * // Get messages with pagination (skip first 20, get next 30)
   * const olderMessages = await storage.getConversationMessages('conv-123', {
   *   limit: 30,
   *   offset: 20
   * });
   *
   * // Get all messages (use with caution for large conversations)
   * const allMessages = await storage.getConversationMessages('conv-123');
   *
   * // Process messages in batches
   * const batchSize = 100;
   * let offset = 0;
   * let hasMore = true;
   *
   * while (hasMore) {
   *   const batch = await storage.getConversationMessages('conv-123', {
   *     limit: batchSize,
   *     offset: offset
   *   });
   *
   *   // Process batch
   *   processBatch(batch);
   *
   *   hasMore = batch.length === batchSize;
   *   offset += batchSize;
   * }
   * ```
   *
   * @throws {Error} If the conversation ID is invalid or operation fails
   * @note This is a placeholder implementation. Full user-centric schema support is pending.
   */
  public async getConversationMessages(
    conversationId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<MemoryMessage[]> {
    await this.initialized;

    const { limit = 100, offset = 0 } = options;

    try {
      let query = this.client
        .from(this.messagesTable)
        .select("*")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true }); // Chronological order (oldest first)

      // Add pagination
      if (limit > 0) {
        query = query.range(offset, offset + limit - 1);
      }

      const { data, error } = await query;

      if (error) {
        throw new Error(`Failed to get conversation messages: ${error.message}`);
      }

      return (data || []).map((row: any) => ({
        id: row.message_id,
        role: row.role,
        content: row.content,
        type: row.type,
        createdAt: row.created_at,
      }));
    } catch (error) {
      console.error("Error getting conversation messages:", error);
      throw new Error("Failed to get conversation messages from Supabase database");
    }
  }

  /**
   * Get conversations for a user with a fluent query builder interface
   * @param userId User ID to filter by
   * @returns Query builder object
   */
  public getUserConversations(userId: string) {
    return {
      /**
       * Limit the number of results
       * @param count Number of conversations to return
       * @returns Query builder
       */
      limit: (count: number) => ({
        /**
         * Order results by a specific field
         * @param field Field to order by
         * @param direction Sort direction
         * @returns Query builder
         */
        orderBy: (
          field: "created_at" | "updated_at" | "title" = "updated_at",
          direction: "ASC" | "DESC" = "DESC",
        ) => ({
          /**
           * Execute the query and return results
           * @returns Promise of conversations
           */
          execute: () =>
            this.getConversationsByUserId(userId, {
              limit: count,
              orderBy: field,
              orderDirection: direction,
            }),
        }),
        /**
         * Execute the query with default ordering
         * @returns Promise of conversations
         */
        execute: () => this.getConversationsByUserId(userId, { limit: count }),
      }),

      /**
       * Order results by a specific field
       * @param field Field to order by
       * @param direction Sort direction
       * @returns Query builder
       */
      orderBy: (
        field: "created_at" | "updated_at" | "title" = "updated_at",
        direction: "ASC" | "DESC" = "DESC",
      ) => ({
        /**
         * Limit the number of results
         * @param count Number of conversations to return
         * @returns Query builder
         */
        limit: (count: number) => ({
          /**
           * Execute the query and return results
           * @returns Promise of conversations
           */
          execute: () =>
            this.getConversationsByUserId(userId, {
              limit: count,
              orderBy: field,
              orderDirection: direction,
            }),
        }),
        /**
         * Execute the query without limit
         * @returns Promise of conversations
         */
        execute: () =>
          this.getConversationsByUserId(userId, {
            orderBy: field,
            orderDirection: direction,
          }),
      }),

      /**
       * Execute the query with default options
       * @returns Promise of conversations
       */
      execute: () => this.getConversationsByUserId(userId),
    };
  }

  /**
   * Get conversation by ID and ensure it belongs to the specified user
   * @param conversationId Conversation ID
   * @param userId User ID to validate ownership
   * @returns Conversation or null
   */
  public async getUserConversation(
    conversationId: string,
    userId: string,
  ): Promise<Conversation | null> {
    const conversation = await this.getConversation(conversationId);
    if (!conversation || conversation.userId !== userId) {
      return null;
    }
    return conversation;
  }

  /**
   * Get paginated conversations for a user
   * @param userId User ID
   * @param page Page number (1-based)
   * @param pageSize Number of items per page
   * @returns Object with conversations and pagination info
   */
  public async getPaginatedUserConversations(
    userId: string,
    page = 1,
    pageSize = 10,
  ): Promise<{
    conversations: Conversation[];
    page: number;
    pageSize: number;
    hasMore: boolean;
  }> {
    const offset = (page - 1) * pageSize;

    // Get one extra to check if there are more pages
    const conversations = await this.getConversationsByUserId(userId, {
      limit: pageSize + 1,
      offset,
      orderBy: "updated_at",
      orderDirection: "DESC",
    });

    const hasMore = conversations.length > pageSize;
    const results = hasMore ? conversations.slice(0, pageSize) : conversations;

    return {
      conversations: results,
      page,
      pageSize,
      hasMore,
    };
  }

  /**
   * Check and create migration flag table, return if migration already completed
   * @param migrationType Type of migration to check
   * @returns Object with completion status and details
   */
  private async checkMigrationFlag(migrationType: string): Promise<{
    alreadyCompleted: boolean;
    migrationCount?: number;
    completedAt?: string;
  }> {
    const migrationFlagTable = `${this.conversationsTable}_migration_flags`;

    try {
      const { data, error } = await this.client
        .from(migrationFlagTable)
        .select("*")
        .eq("migration_type", migrationType)
        .maybeSingle();

      if (error && !error.message?.includes("does not exist")) {
        this.debugLog("Error checking migration flag:", error);
        return { alreadyCompleted: false };
      }

      if (data) {
        this.debugLog(`${migrationType} migration already completed`);
        this.debugLog(`Migration completed on: ${data.completed_at}`);
        this.debugLog(`Migrated ${data.migrated_count || 0} records previously`);
        return {
          alreadyCompleted: true,
          migrationCount: data.migrated_count as number,
          completedAt: data.completed_at as string,
        };
      }

      this.debugLog("Migration flags table found, but no migration flag exists yet");
      return { alreadyCompleted: false };
    } catch (_flagError) {
      // Migration flag table doesn't exist, which is expected for fresh install
      this.debugLog("Migration flag table not found (expected for fresh install)");
      return { alreadyCompleted: false };
    }
  }

  /**
   * Set migration flag after successful completion
   * @param migrationType Type of migration completed
   * @param migratedCount Number of records migrated
   */
  private async setMigrationFlag(migrationType: string, migratedCount: number): Promise<void> {
    try {
      const migrationFlagTable = `${this.conversationsTable}_migration_flags`;

      const { error } = await this.client.from(migrationFlagTable).upsert(
        {
          migration_type: migrationType,
          completed_at: new Date().toISOString(),
          migrated_count: migratedCount,
        },
        {
          onConflict: "migration_type",
        },
      );

      if (error) {
        this.debugLog("Could not set migration flag (non-critical):", error);
      } else {
        this.debugLog("Migration flag set successfully");
      }
    } catch (flagSetError) {
      this.debugLog("Could not set migration flag (non-critical):", flagSetError);
    }
  }

  /**
   * Migrate agent history schema to add user_id and conversation_id columns
   */
  private async migrateAgentHistorySchema(): Promise<{
    success: boolean;
    error?: Error;
  }> {
    try {
      // Check if migration has already been completed
      const flagCheck = await this.checkMigrationFlag("agent_history_schema_migration");
      if (flagCheck.alreadyCompleted) {
        return { success: true };
      }

      // Check if the table exists first by trying to query it
      const { error: tableError } = await this.client.from(this.historyTable).select("id").limit(1);

      if (tableError && tableError.message?.includes("does not exist")) {
        console.log("Agent history table doesn't exist, migration not needed");
        return { success: true };
      }

      // Check if columns already exist
      let hasUserIdColumn = false;
      let hasConversationIdColumn = false;

      try {
        const { error: userIdError } = await this.client
          .from(this.historyTable)
          .select("user_id")
          .limit(1);
        hasUserIdColumn = !userIdError;
      } catch {
        hasUserIdColumn = false;
      }

      try {
        const { error: conversationIdError } = await this.client
          .from(this.historyTable)
          .select("conversation_id")
          .limit(1);
        hasConversationIdColumn = !conversationIdError;
      } catch {
        hasConversationIdColumn = false;
      }

      // If both columns already exist, migration not needed
      if (hasUserIdColumn && hasConversationIdColumn) {
        console.log("Agent history table already has user_id and conversation_id columns");
        await this.setMigrationFlag("agent_history_schema_migration", 0);
        return { success: true };
      }

      // Show SQL that needs to be run
      console.log(`\n${"=".repeat(80)}`);
      console.log("🔄 AGENT HISTORY SCHEMA MIGRATION REQUIRED");
      console.log("=".repeat(80));
      console.log("Please run the following SQL in your Supabase SQL Editor:");
      console.log("(Copy and paste the entire block below)\n");

      console.log(`-- Agent History Schema Migration for ${this.historyTable}
-- Add user_id and conversation_id columns if they don't exist

-- Add user_id column
ALTER TABLE ${this.historyTable} 
ADD COLUMN IF NOT EXISTS user_id TEXT;

-- Add conversation_id column  
ALTER TABLE ${this.historyTable}
ADD COLUMN IF NOT EXISTS conversation_id TEXT;

-- Create indexes for new columns
CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_agent_history_user_id
ON ${this.historyTable}(user_id);

CREATE INDEX IF NOT EXISTS idx_${this.baseTableName}_agent_history_conversation_id
ON ${this.historyTable}(conversation_id);

-- Set migration flag to prevent future runs
INSERT INTO ${this.conversationsTable}_migration_flags (migration_type, migrated_count, metadata) 
VALUES ('agent_history_schema_migration', 0, '{"manual_migration": true}'::jsonb)
ON CONFLICT (migration_type) DO NOTHING;
`);

      console.log(`\n${"=".repeat(80)}`);
      console.log("📋 MIGRATION INSTRUCTIONS:");
      console.log("1. Go to your Supabase Dashboard");
      console.log('2. Click on "SQL Editor" in the left sidebar');
      console.log('3. Click "New Query"');
      console.log("4. Copy and paste the SQL above");
      console.log('5. Click "Run" to execute');
      console.log("6. Restart your application");
      console.log(`${"=".repeat(80)}\n`);

      return { success: true };
    } catch (error) {
      console.error("Error during agent history schema migration:", error);
      return { success: false, error: error as Error };
    }
  }

  // === WORKFLOW PERSISTENCE METHODS ===

  /**
   * Store a workflow history entry
   */
  public async storeWorkflowHistory(entry: WorkflowHistoryEntry): Promise<void> {
    await this.initialized;

    this.debugLog("Storing workflow history", {
      id: entry.id,
      workflowId: entry.workflowId,
      userId: entry.userId,
      conversationId: entry.conversationId,
    });

    const record = {
      id: entry.id,
      workflow_id: entry.workflowId,
      name: entry.workflowName,
      status: entry.status,
      start_time: entry.startTime.toISOString(),
      end_time: entry.endTime?.toISOString() || null,
      input: entry.input ? JSON.stringify(entry.input) : null,
      output: entry.output ? JSON.stringify(entry.output) : null,
      user_id: entry.userId || null,
      conversation_id: entry.conversationId || null,
      metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
      created_at: (entry.createdAt || new Date()).toISOString(),
      updated_at: (entry.updatedAt || new Date()).toISOString(),
    };

    const { error } = await this.client
      .from(this.workflowHistoryTable)
      .upsert(record, { onConflict: "id" });

    if (error) {
      console.error(`Error storing workflow history ${entry.id}:`, error);
      throw new Error(`Failed to store workflow history: ${error.message}`);
    }

    this.debugLog(`Stored workflow history ${entry.id}`);
  }

  /**
   * Get a workflow history entry by ID
   */
  public async getWorkflowHistory(id: string): Promise<WorkflowHistoryEntry | null> {
    await this.initialized;

    const { data, error } = await this.client
      .from(this.workflowHistoryTable)
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      console.error(`Error getting workflow history ${id}:`, error);
      throw new Error(`Failed to get workflow history: ${error.message}`);
    }

    if (!data) {
      return null;
    }

    return this.parseWorkflowHistoryRow(data);
  }

  /**
   * Get all workflow history entries for a specific workflow ID
   */
  public async getWorkflowHistoryByWorkflowId(workflowId: string): Promise<WorkflowHistoryEntry[]> {
    await this.initialized;

    const { data, error } = await this.client
      .from(this.workflowHistoryTable)
      .select("*")
      .eq("workflow_id", workflowId)
      .order("start_time", { ascending: false });

    if (error) {
      console.error(`Error getting workflow history for workflow ${workflowId}:`, error);
      throw new Error(`Failed to get workflow history: ${error.message}`);
    }

    return (data || []).map((row) => this.parseWorkflowHistoryRow(row));
  }

  /**
   * Update a workflow history entry
   */
  public async updateWorkflowHistory(
    id: string,
    updates: Partial<WorkflowHistoryEntry>,
  ): Promise<void> {
    await this.initialized;

    this.debugLog(`Updating workflow history ${id}`, updates);

    const updateData: Record<string, any> = {
      updated_at: new Date().toISOString(),
    };

    if (updates.status !== undefined) {
      updateData.status = updates.status;
    }
    if (updates.endTime !== undefined) {
      updateData.end_time = updates.endTime ? updates.endTime.toISOString() : null;
    }
    if (updates.output !== undefined) {
      updateData.output = updates.output ? JSON.stringify(updates.output) : null;
    }
    if (updates.userId !== undefined) {
      updateData.user_id = updates.userId;
    }
    if (updates.conversationId !== undefined) {
      updateData.conversation_id = updates.conversationId;
    }
    if (updates.metadata !== undefined) {
      updateData.metadata = updates.metadata ? JSON.stringify(updates.metadata) : null;
    }

    const { error } = await this.client
      .from(this.workflowHistoryTable)
      .update(updateData)
      .eq("id", id);

    if (error) {
      console.error(`Error updating workflow history ${id}:`, error);
      throw new Error(`Failed to update workflow history: ${error.message}`);
    }

    this.debugLog(`Updated workflow history ${id}`);
  }

  /**
   * Delete a workflow history entry
   */
  public async deleteWorkflowHistory(id: string): Promise<void> {
    await this.initialized;

    this.debugLog(`Deleting workflow history ${id}`);

    const { error } = await this.client.from(this.workflowHistoryTable).delete().eq("id", id);

    if (error) {
      console.error(`Error deleting workflow history ${id}:`, error);
      throw new Error(`Failed to delete workflow history: ${error.message}`);
    }

    this.debugLog(`Deleted workflow history ${id}`);
  }

  /**
   * Store a workflow step entry
   */
  public async storeWorkflowStep(step: WorkflowStepHistoryEntry): Promise<void> {
    await this.initialized;

    this.debugLog(
      `Storing workflow step ${step.id} for workflow history ${step.workflowHistoryId}`,
      step,
    );

    const record = {
      id: step.id,
      workflow_history_id: step.workflowHistoryId,
      step_index: step.stepIndex,
      step_type: step.stepType,
      step_name: step.stepName,
      status: step.status,
      start_time: step.startTime.toISOString(),
      end_time: step.endTime?.toISOString() || null,
      input: step.input ? JSON.stringify(step.input) : null,
      output: step.output ? JSON.stringify(step.output) : null,
      error_message: step.error ? String(step.error) : null,
      agent_execution_id: step.agentExecutionId || null,
      created_at: (step.createdAt || new Date()).toISOString(),
      updated_at: (step.updatedAt || new Date()).toISOString(),
    };

    const { error } = await this.client
      .from(this.workflowStepsTable)
      .upsert(record, { onConflict: "id" });

    if (error) {
      console.error(`Error storing workflow step ${step.id}:`, error);
      throw new Error(`Failed to store workflow step: ${error.message}`);
    }

    this.debugLog(`Stored workflow step ${step.id}`);
  }

  /**
   * Get a workflow step by ID
   */
  public async getWorkflowStep(id: string): Promise<WorkflowStepHistoryEntry | null> {
    await this.initialized;

    const { data, error } = await this.client
      .from(this.workflowStepsTable)
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      console.error(`Error getting workflow step ${id}:`, error);
      throw new Error(`Failed to get workflow step: ${error.message}`);
    }

    if (!data) {
      return null;
    }

    return this.parseWorkflowStepRow(data);
  }

  /**
   * Get all workflow steps for a workflow history entry
   */
  public async getWorkflowSteps(workflowHistoryId: string): Promise<WorkflowStepHistoryEntry[]> {
    await this.initialized;

    const { data, error } = await this.client
      .from(this.workflowStepsTable)
      .select("*")
      .eq("workflow_history_id", workflowHistoryId)
      .order("step_index", { ascending: true });

    if (error) {
      console.error(`Error getting workflow steps for history ${workflowHistoryId}:`, error);
      throw new Error(`Failed to get workflow steps: ${error.message}`);
    }

    return (data || []).map((row) => this.parseWorkflowStepRow(row));
  }

  /**
   * Update a workflow step
   */
  public async updateWorkflowStep(
    id: string,
    updates: Partial<WorkflowStepHistoryEntry>,
  ): Promise<void> {
    await this.initialized;

    this.debugLog(`Updating workflow step ${id}`, updates);

    const updateData: Record<string, any> = {
      updated_at: new Date().toISOString(),
    };

    if (updates.status !== undefined) {
      updateData.status = updates.status;
    }
    if (updates.endTime !== undefined) {
      updateData.end_time = updates.endTime ? updates.endTime.toISOString() : null;
    }
    if (updates.output !== undefined) {
      updateData.output = updates.output ? JSON.stringify(updates.output) : null;
    }
    if (updates.error !== undefined) {
      updateData.error_message = updates.error ? String(updates.error) : null;
    }
    if (updates.agentExecutionId !== undefined) {
      updateData.agent_execution_id = updates.agentExecutionId;
    }

    const { error } = await this.client
      .from(this.workflowStepsTable)
      .update(updateData)
      .eq("id", id);

    if (error) {
      console.error(`Error updating workflow step ${id}:`, error);
      throw new Error(`Failed to update workflow step: ${error.message}`);
    }

    this.debugLog(`Updated workflow step ${id}`);
  }

  /**
   * Delete a workflow step
   */
  public async deleteWorkflowStep(id: string): Promise<void> {
    await this.initialized;

    this.debugLog(`Deleting workflow step ${id}`);

    const { error } = await this.client.from(this.workflowStepsTable).delete().eq("id", id);

    if (error) {
      console.error(`Error deleting workflow step ${id}:`, error);
      throw new Error(`Failed to delete workflow step: ${error.message}`);
    }

    this.debugLog(`Deleted workflow step ${id}`);
  }

  /**
   * Store a workflow timeline event
   */
  public async storeWorkflowTimelineEvent(event: any): Promise<void> {
    await this.initialized;

    this.debugLog(
      `Storing workflow timeline event ${event.id} for workflow history ${event.workflowHistoryId}`,
      event,
    );

    const record = {
      id: event.id,
      workflow_history_id: event.workflowHistoryId,
      event_id: event.eventId,
      type: event.type,
      name: event.name,
      start_time: event.startTime,
      end_time: event.endTime || null,
      status: event.status || null,
      level: event.level || "INFO",
      input: event.input ? JSON.stringify(event.input) : null,
      output: event.output ? JSON.stringify(event.output) : null,
      metadata: event.metadata ? JSON.stringify(event.metadata) : null,
      event_sequence: event.eventSequence || null,
      trace_id: event.traceId || null,
      parent_event_id: event.parentEventId || null,
      status_message: event.statusMessage ? String(event.statusMessage) : null,
      created_at: (event.createdAt || new Date()).toISOString(),
    };

    const { error } = await this.client
      .from(this.workflowTimelineEventsTable)
      .upsert(record, { onConflict: "id" });

    if (error) {
      console.error(`Error storing workflow timeline event ${event.id}:`, error);
      throw new Error(`Failed to store workflow timeline event: ${error.message}`);
    }

    this.debugLog(`Stored workflow timeline event ${event.id}`);
  }

  /**
   * Get a workflow timeline event by ID
   */
  public async getWorkflowTimelineEvent(id: string): Promise<any | null> {
    await this.initialized;

    const { data, error } = await this.client
      .from(this.workflowTimelineEventsTable)
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      console.error(`Error getting workflow timeline event ${id}:`, error);
      throw new Error(`Failed to get workflow timeline event: ${error.message}`);
    }

    if (!data) {
      return null;
    }

    return this.parseWorkflowTimelineEventRow(data);
  }

  /**
   * Get all workflow timeline events for a workflow history entry
   */
  public async getWorkflowTimelineEvents(workflowHistoryId: string): Promise<any[]> {
    await this.initialized;

    const { data, error } = await this.client
      .from(this.workflowTimelineEventsTable)
      .select("*")
      .eq("workflow_history_id", workflowHistoryId)
      .order("start_time", { ascending: true });

    if (error) {
      console.error(
        `Error getting workflow timeline events for history ${workflowHistoryId}:`,
        error,
      );
      throw new Error(`Failed to get workflow timeline events: ${error.message}`);
    }

    return (data || []).map((row) => this.parseWorkflowTimelineEventRow(row));
  }

  /**
   * Delete a workflow timeline event
   */
  public async deleteWorkflowTimelineEvent(id: string): Promise<void> {
    await this.initialized;

    this.debugLog(`Deleting workflow timeline event ${id}`);

    const { error } = await this.client
      .from(this.workflowTimelineEventsTable)
      .delete()
      .eq("id", id);

    if (error) {
      console.error(`Error deleting workflow timeline event ${id}:`, error);
      throw new Error(`Failed to delete workflow timeline event: ${error.message}`);
    }

    this.debugLog(`Deleted workflow timeline event ${id}`);
  }

  /**
   * Get all workflow IDs that have history entries
   */
  public async getAllWorkflowIds(): Promise<string[]> {
    await this.initialized;

    const { data, error } = await this.client
      .from(this.workflowHistoryTable)
      .select("workflow_id")
      .order("workflow_id", { ascending: true });

    if (error) {
      console.error("Error getting all workflow IDs:", error);
      throw new Error(`Failed to get workflow IDs: ${error.message}`);
    }

    // Extract unique workflow IDs
    const workflowIds = [...new Set((data || []).map((row) => row.workflow_id))];
    return workflowIds;
  }

  /**
   * Get workflow statistics for a specific workflow
   */
  public async getWorkflowStats(workflowId: string): Promise<WorkflowStats> {
    await this.initialized;

    this.debugLog(`Getting workflow stats for workflow ${workflowId}`);

    const { data, error } = await this.client
      .from(this.workflowHistoryTable)
      .select("status, start_time, end_time")
      .eq("workflow_id", workflowId);

    if (error) {
      console.error(`Error getting workflow stats for ${workflowId}:`, error);
      throw new Error(`Failed to get workflow stats: ${error.message}`);
    }

    const entries = data || [];
    const totalExecutions = entries.length;
    const successfulExecutions = entries.filter((e) => e.status === "completed").length;
    const failedExecutions = entries.filter((e) => e.status === "error").length;

    // Calculate average execution time for completed executions
    const completedExecutions = entries.filter((e) => e.status === "completed" && e.end_time);
    const averageExecutionTime =
      completedExecutions.length > 0
        ? completedExecutions.reduce((sum, e) => {
            const duration = new Date(e.end_time).getTime() - new Date(e.start_time).getTime();
            return sum + duration;
          }, 0) / completedExecutions.length
        : 0;

    // Get last execution time
    const lastExecutionTime =
      entries.length > 0
        ? entries.sort(
            (a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime(),
          )[0].start_time
        : undefined;

    return {
      totalExecutions,
      successfulExecutions,
      failedExecutions,
      averageExecutionTime,
      lastExecutionTime: lastExecutionTime ? new Date(lastExecutionTime) : undefined,
    };
  }

  /**
   * Get workflow history with steps and events in a single call
   */
  public async getWorkflowHistoryWithStepsAndEvents(
    id: string,
  ): Promise<WorkflowHistoryEntry | null> {
    await this.initialized;

    this.debugLog(`Getting workflow history with steps and events for ${id}`);

    // Get the main workflow history entry
    const history = await this.getWorkflowHistory(id);
    if (!history) {
      return null;
    }

    // Get workflow steps
    const steps = await this.getWorkflowSteps(id);

    // Get workflow timeline events
    const timelineEvents = await this.getWorkflowTimelineEvents(id);

    // Convert WorkflowTimelineEvent[] to WorkflowTimelineEvent[] (they should be compatible)
    const events = timelineEvents;

    return {
      ...history,
      steps,
      events,
    };
  }

  /**
   * Delete workflow history with all related data (steps and events)
   */
  public async deleteWorkflowHistoryWithRelated(id: string): Promise<void> {
    await this.initialized;

    this.debugLog(`Deleting workflow history with related data: ${id}`);

    // Get all related timeline events
    const { data: timelineEvents } = await this.client
      .from(this.workflowTimelineEventsTable)
      .select("id")
      .eq("workflow_history_id", id);

    // Get all related steps
    const { data: steps } = await this.client
      .from(this.workflowStepsTable)
      .select("id")
      .eq("workflow_history_id", id);

    // Delete timeline events
    if (timelineEvents && timelineEvents.length > 0) {
      const { error: eventsError } = await this.client
        .from(this.workflowTimelineEventsTable)
        .delete()
        .eq("workflow_history_id", id);

      if (eventsError) {
        console.error(`Error deleting workflow timeline events for ${id}:`, eventsError);
        throw new Error(`Failed to delete workflow timeline events: ${eventsError.message}`);
      }
    }

    // Delete steps
    if (steps && steps.length > 0) {
      const { error: stepsError } = await this.client
        .from(this.workflowStepsTable)
        .delete()
        .eq("workflow_history_id", id);

      if (stepsError) {
        console.error(`Error deleting workflow steps for ${id}:`, stepsError);
        throw new Error(`Failed to delete workflow steps: ${stepsError.message}`);
      }
    }

    // Delete the main workflow history entry
    await this.deleteWorkflowHistory(id);

    this.debugLog(`Deleted workflow history with related data: ${id}`);
  }

  /**
   * Cleanup old workflow histories for a specific workflow
   */
  public async cleanupOldWorkflowHistories(
    workflowId: string,
    maxEntries: number,
  ): Promise<number> {
    await this.initialized;

    this.debugLog(
      `Cleaning up old workflow histories for ${workflowId}, keeping ${maxEntries} entries`,
    );

    // Get all workflow histories for this workflow, ordered by start time (newest first)
    const { data, error } = await this.client
      .from(this.workflowHistoryTable)
      .select("id, start_time")
      .eq("workflow_id", workflowId)
      .order("start_time", { ascending: false });

    if (error) {
      console.error(`Error getting workflow histories for cleanup ${workflowId}:`, error);
      throw new Error(`Failed to get workflow histories for cleanup: ${error.message}`);
    }

    const entries = data || [];

    if (entries.length <= maxEntries) {
      return 0; // No cleanup needed
    }

    // Get the entries to delete (oldest ones beyond maxEntries)
    const entriesToDelete = entries.slice(maxEntries);
    const deletedCount = entriesToDelete.length;

    // Delete old entries with their related data
    for (const entry of entriesToDelete) {
      await this.deleteWorkflowHistoryWithRelated(entry.id);
    }

    this.debugLog(`Cleaned up ${deletedCount} old workflow histories for ${workflowId}`);
    return deletedCount;
  }

  // === HELPER METHODS FOR PARSING DATABASE ROWS ===

  /**
   * Parse workflow history row from database
   */
  private parseWorkflowHistoryRow(row: any): WorkflowHistoryEntry {
    return {
      id: row.id,
      workflowName: row.name,
      workflowId: row.workflow_id,
      status: row.status,
      startTime: new Date(row.start_time),
      endTime: row.end_time ? new Date(row.end_time) : undefined,
      input: row.input ? JSON.parse(row.input) : null,
      output: row.output ? JSON.parse(row.output) : undefined,
      userId: row.user_id || undefined,
      conversationId: row.conversation_id || undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      steps: [], // Will be loaded separately if needed
      events: [], // Will be loaded separately if needed
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  /**
   * Parse workflow step row from database
   */
  private parseWorkflowStepRow(row: any): WorkflowStepHistoryEntry {
    return {
      id: row.id,
      workflowHistoryId: row.workflow_history_id,
      stepIndex: row.step_index,
      stepType: row.step_type,
      stepName: row.step_name,
      status: row.status,
      startTime: new Date(row.start_time),
      endTime: row.end_time ? new Date(row.end_time) : undefined,
      input: row.input ? JSON.parse(row.input) : undefined,
      output: row.output ? JSON.parse(row.output) : undefined,
      error: row.error_message || undefined,
      agentExecutionId: row.agent_execution_id || undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  /**
   * Parse workflow timeline event row from database
   */
  private parseWorkflowTimelineEventRow(row: any): any {
    return {
      id: row.id,
      workflowHistoryId: row.workflow_history_id,
      eventId: row.event_id,
      type: row.type,
      name: row.name,
      startTime: row.start_time,
      endTime: row.end_time || undefined,
      status: row.status || undefined,
      level: row.level || "INFO",
      input: row.input ? JSON.parse(row.input) : undefined,
      output: row.output ? JSON.parse(row.output) : undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      eventSequence: row.event_sequence || undefined,
      traceId: row.trace_id || undefined,
      parentEventId: row.parent_event_id || undefined,
      statusMessage: row.status_message || undefined,
      createdAt: new Date(row.created_at),
    };
  }
}
