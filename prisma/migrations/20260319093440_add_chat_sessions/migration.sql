-- AlterTable
ALTER TABLE "query_logs" ADD COLUMN     "session_id" TEXT,
ADD COLUMN     "turn_index" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "chat_sessions" (
    "id" TEXT NOT NULL,
    "title" TEXT,
    "site_key" TEXT,
    "document_id" TEXT,
    "turn_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_sessions_created_at_idx" ON "chat_sessions"("created_at");

-- CreateIndex
CREATE INDEX "query_logs_session_id_idx" ON "query_logs"("session_id");

-- AddForeignKey
ALTER TABLE "query_logs" ADD CONSTRAINT "query_logs_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "chat_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
