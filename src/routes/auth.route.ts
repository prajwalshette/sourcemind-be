import { Router, type IRouter } from "express";
import { register, login, getMe } from "@controllers/auth.controller";
import { AuthMiddleware } from "@middlewares/auth.middleware";
import { ValidationMiddleware } from "@middlewares/validation.middleware";
import { registerSchema, loginSchema } from "@schemas/auth.schema";

const router: IRouter = Router();

router.post("/register", ValidationMiddleware(registerSchema), register);
router.post("/login", ValidationMiddleware(loginSchema), login);
router.get("/me", AuthMiddleware, getMe);

export default router;
