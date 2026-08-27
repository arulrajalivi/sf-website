/**
 * An in-memory stand-in for the three tables the generation slice writes.
 *
 * The point of these tests is *our* ordering rule — raw text first, rows only
 * after validation — which a mocked `prisma.story.create` proves as well as a
 * live database and without one. What it deliberately does not model is SQL
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
  /** Every story write attempt, including ones inside a rolled-back path. */
  storyCreateCalls = 0;
  private sequence = 0;

  reset(): void {
    this.requirements = [];
    this.stories = [];
    this.tasks = [];
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

export interface FakePrismaClient {
  requirement: typeof requirementDelegate;
  story: typeof storyDelegate;
  task: typeof taskDelegate;
  $transaction<T>(fn: (tx: FakePrismaClient) => Promise<T>): Promise<T>;
}

export const fakePrisma: FakePrismaClient = {
  requirement: requirementDelegate,
  story: storyDelegate,
  task: taskDelegate,
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
