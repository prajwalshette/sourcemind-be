import { Router, type IRouter } from "express";
import { health } from "@/api/controllers/health.controller";

const router: IRouter = Router();

router.get("/", health);

export default router;
