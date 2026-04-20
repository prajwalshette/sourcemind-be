import { Router, type IRouter } from "express";
import { submitFeedback } from "@/api/controllers/feedback.controller";

const router: IRouter = Router();

router.post("/", submitFeedback);

export default router;
