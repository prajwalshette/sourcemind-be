import { Router, type IRouter } from "express";
import { health } from "@controllers/health.controller";

const router: IRouter = Router();

router.get("/", health);

export default router;
