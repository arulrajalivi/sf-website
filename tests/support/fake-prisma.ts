/**
 * An in-memory stand-in for the tables the generation and push slices write.
 *
 * The point of these tests is *our* rules — raw text first and rows only after
 * validation, one push record per item — which a mocked delegate proves as well
 * as a live database and without one. What it deliberately does not model is SQL
 * behaviour (constraints, cascades); the committed migration is exercised
 * against real Postgres in CI instead.
 */

export interface FakeRequirementRow {
  id: string;
  userId: string;
  title: string;
  rawText: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface FakeStoryRow {
  id: string;
  requirementId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  order: number;
}

export interface FakeTaskRow {
  id: string;
  storyId: string;
  title: string;
  description: string | null;
  order: number;
}

export interface FakeIntegrationRow {
  id: string;
  userId: string;
  provider: string;
  status: string;
  accountLabel: string | null;
  workspaceRef: string | null;
  accessTokenEnc: string | null;
  refreshTokenEnc: string | null;
  expiresAt: Date | null;
  scope: string | null;
  lastRefreshedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FakePushRecordRow {
  id: string;
  userId: string;
  integrationId: string;
  provider: string;
  status: string;
  externalId: string | null;
  externalUrl: string | null;
  error: string | null;
  itemTitle: string;
  requirementId: string | null;
  storyId: string | null;
  taskId: string | null;
  pushedAt: Date;
}

interface Where {
  id?: string;
  userId?: string;
  requirementId?: string;
  requirement?: { userId?: string };
  story?: { requirement?: { userId?: string } };
}

class FakeDatabase {
  requirements: FakeRequirementRow[] = [];
  stories: FakeStoryRow[] = [];
  tasks: FakeTaskRow[] = [];
  integrations: FakeIntegrationRow[] = [];
  pushRecords: FakePushRecordRow[] = [];
  /** Every story write attempt, including ones inside a rolled-back path. */
  storyCreateCalls = 0;
  private sequence = 0;

  reset(): void {
    this.requirements = [];
    this.stories = [];
    this.tasks = [];
    this.integrations = [];
    this.pushRecords = [];
    this.storyCreateCalls = 0;
    this.sequence = 0;
  }

  nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_${this.sequence}`;
  }
}

export const fakeDb = new FakeDatabase();

export function resetFakePrisma(): void {
  fakeDb.reset();
}

function ownsRequirement(row: FakeRequirementRow, where: Where): boolean {
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.userId !== undefined && row.userId !== where.userId) return false;
  return true;
}

function storyOwnerId(story: FakeStoryRow): string | undefined {
  return fakeDb.requirements.find((r) => r.id === story.requirementId)?.userId;
}

const requirementDelegate = {
  async create({
    data,
  }: {
    data: { userId: string; title: string; rawText: string };
  }) {
    const now = new Date();
    const row: FakeRequirementRow = {
      id: fakeDb.nextId("req"),
      userId: data.userId,
      title: data.title,
      rawText: data.rawText,
      createdAt: now,
      updatedAt: now,
    };
    fakeDb.requirements.push(row);
    return { ...row };
  },

  async findFirst({ where }: { where: Where }) {
    const row = fakeDb.requirements.find((r) => ownsRequirement(r, where));
    if (!row) return null;
    return {
      ...row,
      stories: fakeDb.stories
        .filter((s) => s.requirementId === row.id)
        .sort((a, b) => a.order - b.order)
        .map((story) => ({
          ...story,
          tasks: fakeDb.tasks
            .filter((t) => t.storyId === story.id)
            .sort((a, b) => a.order - b.order)
            .map((task) => ({ ...task })),
        })),
    };
  },

  async findMany({ where }: { where: Where }) {
    return fakeDb.requirements
      .filter((r) => ownsRequirement(r, where))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((row) => ({
        ...row,
        _count: {
          stories: fakeDb.stories.filter((s) => s.requirementId === row.id)
            .length,
        },
      }));
  },
};

const storyDelegate = {
  async deleteMany({ where }: { where: Where }) {
    const doomed = fakeDb.stories.filter(
      (s) => s.requirementId === where.requirementId,
    );
    fakeDb.stories = fakeDb.stories.filter((s) => !doomed.includes(s));
    // Mirrors the schema's onDelete: Cascade.
    fakeDb.tasks = fakeDb.tasks.filter(
      (t) => !doomed.some((s) => s.id === t.storyId),
    );
    return { count: doomed.length };
  },

  async create({
    data,
  }: {
    data: {
      requirementId: string;
      title: string;
      description: string;
      acceptanceCriteria: string[];
      order: number;
      tasks?: {
        create: { title: string; description: string | null; order: number }[];
      };
    };
  }) {
    fakeDb.storyCreateCalls += 1;
    const story: FakeStoryRow = {
      id: fakeDb.nextId("story"),
      requirementId: data.requirementId,
      title: data.title,
      description: data.description,
      acceptanceCriteria: [...data.acceptanceCriteria],
      order: data.order,
    };
    fakeDb.stories.push(story);
    for (const task of data.tasks?.create ?? []) {
      fakeDb.tasks.push({
        id: fakeDb.nextId("task"),
        storyId: story.id,
        title: task.title,
        description: task.description,
        order: task.order,
      });
    }
    return { ...story };
  },

  async updateMany({
    where,
    data,
  }: {
    where: Where;
    data: Partial<Pick<FakeStoryRow, "title" | "description">> & {
      acceptanceCriteria?: string[];
    };
  }) {
    const targets = fakeDb.stories.filter(
      (s) =>
        s.id === where.id &&
        (where.requirement?.userId === undefined ||
          storyOwnerId(s) === where.requirement.userId),
    );
    for (const story of targets) Object.assign(story, data);
    return { count: targets.length };
  },
};

const taskDelegate = {
  async updateMany({
    where,
    data,
  }: {
    where: Where;
    data: Partial<Pick<FakeTaskRow, "title" | "description">>;
  }) {
    const requiredOwner = where.story?.requirement?.userId;
    const targets = fakeDb.tasks.filter((t) => {
      if (t.id !== where.id) return false;
      if (requiredOwner === undefined) return true;
      const story = fakeDb.stories.find((s) => s.id === t.storyId);
      return story !== undefined && storyOwnerId(story) === requiredOwner;
    });
    for (const task of targets) Object.assign(task, data);
    return { count: targets.length };
  },
};

const integrationDelegate = {
  async findUnique({
    where,
  }: {
    where: { userId_provider: { userId: string; provider: string } };
  }) {
    const row = fakeDb.integrations.find(
      (integration) =>
        integration.userId === where.userId_provider.userId &&
        integration.provider === where.userId_provider.provider,
    );
    return row ? { ...row } : null;
  },

  async findMany({ where }: { where: { userId: string } }) {
    return fakeDb.integrations
      .filter((integration) => integration.userId === where.userId)
      .map((integration) => ({ ...integration }));
  },

  async update({
    where,
    data,
  }: {
    where: { id: string };
    data: Partial<FakeIntegrationRow>;
  }) {
    const row = fakeDb.integrations.find(
      (integration) => integration.id === where.id,
    );
    if (!row) throw new Error(`No integration ${where.id}`);
    Object.assign(row, data);
    return { ...row };
  },
};

const pushRecordDelegate = {
  async create({ data }: { data: Omit<FakePushRecordRow, "id" | "pushedAt"> }) {
    const row: FakePushRecordRow = {
      ...data,
      id: fakeDb.nextId("push"),
      pushedAt: new Date(Date.now() + fakeDb.pushRecords.length),
    };
    fakeDb.pushRecords.push(row);
    return { ...row };
  },

  async findMany({ where, take }: { where: { userId: string }; take?: number }) {
    return fakeDb.pushRecords
      .filter((record) => record.userId === where.userId)
      .sort((a, b) => b.pushedAt.getTime() - a.pushedAt.getTime())
      .slice(0, take ?? undefined)
      .map((record) => ({
        ...record,
        requirement: record.requirementId
          ? {
              title:
                fakeDb.requirements.find((r) => r.id === record.requirementId)
                  ?.title ?? "",
            }
          : null,
      }));
  },
};

export interface FakePrismaClient {
  requirement: typeof requirementDelegate;
  story: typeof storyDelegate;
  task: typeof taskDelegate;
  integration: typeof integrationDelegate;
  pushRecord: typeof pushRecordDelegate;
  $transaction<T>(fn: (tx: FakePrismaClient) => Promise<T>): Promise<T>;
}

export const fakePrisma: FakePrismaClient = {
  requirement: requirementDelegate,
  story: storyDelegate,
  task: taskDelegate,
  integration: integrationDelegate,
  pushRecord: pushRecordDelegate,
  // No rollback: these tests assert that nothing is *attempted* after a failed
  // validation, which is a stronger property than "it was rolled back".
  async $transaction<T>(fn: (tx: FakePrismaClient) => Promise<T>): Promise<T> {
    return fn(fakePrisma);
  },
};

/** Seeds a requirement directly, for tests that start from an existing row. */
export function seedRequirement(row: {
  id: string;
  userId: string;
  rawText: string;
  title?: string;
}): FakeRequirementRow {
  const now = new Date();
  const seeded: FakeRequirementRow = {
    id: row.id,
    userId: row.userId,
    rawText: row.rawText,
    title: row.title ?? row.rawText.slice(0, 80),
    createdAt: now,
    updatedAt: now,
  };
  fakeDb.requirements.push(seeded);
  return seeded;
}

/** Seeds a connected integration, for tests that start from one. */
export function seedIntegration(row: {
  id: string;
  userId: string;
  provider: string;
  status?: string;
  accessTokenEnc?: string | null;
  refreshTokenEnc?: string | null;
  workspaceRef?: string | null;
  accountLabel?: string | null;
  expiresAt?: Date | null;
}): FakeIntegrationRow {
  const now = new Date();
  const seeded: FakeIntegrationRow = {
    id: row.id,
    userId: row.userId,
    provider: row.provider,
    status: row.status ?? "CONNECTED",
    // `in` rather than `??`: an explicit null is the "connected but no site on
    // file" state, and defaulting it away would hide the case worth testing.
    accountLabel:
      "accountLabel" in row ? (row.accountLabel ?? null) : "jane@acme.test",
    workspaceRef:
      "workspaceRef" in row ? (row.workspaceRef ?? null) : "workspace-1",
    accessTokenEnc: row.accessTokenEnc ?? null,
    refreshTokenEnc: row.refreshTokenEnc ?? null,
    expiresAt: row.expiresAt ?? null,
    scope: null,
    lastRefreshedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  fakeDb.integrations.push(seeded);
  return seeded;
}

/** Seeds a story and its tasks, for tests that start from an existing draft. */
export function seedStory(row: {
  id: string;
  requirementId: string;
  title?: string;
  description?: string;
  acceptanceCriteria?: string[];
  order?: number;
  tasks?: { id: string; title: string; description?: string | null }[];
}): FakeStoryRow {
  const story: FakeStoryRow = {
    id: row.id,
    requirementId: row.requirementId,
    title: row.title ?? "A story",
    description: row.description ?? "As a user, I want something.",
    acceptanceCriteria: row.acceptanceCriteria ?? ["Given, When, Then."],
    order: row.order ?? 0,
  };
  fakeDb.stories.push(story);
  (row.tasks ?? []).forEach((task, index) => {
    fakeDb.tasks.push({
      id: task.id,
      storyId: story.id,
      title: task.title,
      description: task.description ?? null,
      order: index,
    });
  });
  return story;
}
