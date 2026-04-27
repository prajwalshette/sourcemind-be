-- AlterTable
ALTER TABLE "chat_sessions" ADD COLUMN     "user_id" TEXT;

-- AlterTable
ALTER TABLE "query_logs" ADD COLUMN     "user_id" TEXT;

-- CreateIndex
CREATE INDEX "chat_sessions_user_id_idx" ON "chat_sessions"("user_id");

-- CreateIndex
CREATE INDEX "query_logs_user_id_idx" ON "query_logs"("user_id");

-- AddForeignKey
ALTER TABLE "query_logs" ADD CONSTRAINT "query_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
