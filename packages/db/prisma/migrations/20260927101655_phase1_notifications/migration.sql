-- CreateEnum
CREATE TYPE "notification_channel" AS ENUM ('in_app', 'email', 'whatsapp', 'push');

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "channels" JSONB NOT NULL DEFAULT '[]',
    "quiet_hours" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_organization_id_user_id_read_at_created_at_idx" ON "notifications"("organization_id", "user_id", "read_at", "created_at" DESC);

-- CreateIndex
CREATE INDEX "notifications_organization_id_type_idx" ON "notifications"("organization_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_organization_id_user_id_type_key" ON "notification_preferences"("organization_id", "user_id", "type");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_membership_same_org_fk" FOREIGN KEY ("organization_id", "user_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_membership_same_org_fk" FOREIGN KEY ("organization_id", "user_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE;
