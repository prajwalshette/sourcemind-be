import { Router, type IRouter } from "express";
import { register, login, getMe } from "@/api/controllers/auth.controller";
import { AuthMiddleware } from "@/api/middlewares/auth.middleware";
import { ValidationMiddleware } from "@/api/middlewares/validation.middleware";
import { registerSchema, loginSchema } from "@/api/validators/auth.schema";

const router: IRouter = Router();

router.post("/register", ValidationMiddleware(registerSchema), register);
router.post("/login", ValidationMiddleware(loginSchema), login);
router.get("/me", AuthMiddleware, getMe);

export default router;
