-- CreateEnum
CREATE TYPE "PushStatus" AS ENUM ('CREATED', 'FAILED');

-- CreateTable
CREATE TABLE "push_record" (
    "id" TEXT NOT NULL,
    "provider" "Provider" NOT NULL,
    "status" "PushStatus" NOT NULL,
    "externalId" TEXT,
    "externalUrl" TEXT,
    "error" TEXT,
    "itemTitle" TEXT NOT NULL,
    "pushedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "requirementId" TEXT,
    "storyId" TEXT,
    "taskId" TEXT,

    CONSTRAINT "push_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "push_record_userId_pushedAt_idx" ON "push_record"("userId", "pushedAt");

-- CreateIndex
CREATE INDEX "push_record_requirementId_idx" ON "push_record"("requirementId");

-- AddForeignKey
ALTER TABLE "push_record" ADD CONSTRAINT "push_record_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_record" ADD CONSTRAINT "push_record_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_record" ADD CONSTRAINT "push_record_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_record" ADD CONSTRAINT "push_record_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "story"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_record" ADD CONSTRAINT "push_record_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

