-- CreateTable
CREATE TABLE "job_failures" (
    "id" UUID NOT NULL,
    "queue" TEXT NOT NULL,
    "job_name" TEXT NOT NULL,
    "job_id" TEXT,
    "payload" JSONB NOT NULL,
    "error" TEXT NOT NULL,
    "stack" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "retried_at" TIMESTAMPTZ(6),
    "retried_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_failures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduler_heartbeats" (
    "id" UUID NOT NULL,
    "instance_id" TEXT NOT NULL,
    "last_beat_at" TIMESTAMPTZ(6) NOT NULL,
    "registered" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduler_heartbeats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "job_failures_queue_created_at_idx" ON "job_failures"("queue", "created_at" DESC);

-- CreateIndex
CREATE INDEX "job_failures_retried_at_idx" ON "job_failures"("retried_at");

-- CreateIndex
CREATE UNIQUE INDEX "scheduler_heartbeats_instance_id_key" ON "scheduler_heartbeats"("instance_id");

-- CreateIndex
CREATE INDEX "scheduler_heartbeats_last_beat_at_idx" ON "scheduler_heartbeats"("last_beat_at");
