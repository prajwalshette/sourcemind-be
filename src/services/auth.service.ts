import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "@utils/prisma";
import { config } from "@config/env";
import { HttpException } from "@exceptions/httpException";
import type { RegisterDto, LoginDto } from "@dtos/auth.dto";
import { Role } from "@generated/prisma";

function signToken(payload: object): string {
  return jwt.sign(payload, config.JWT_SECRET, {
    expiresIn: config.JWT_EXPIRES_IN,
  } as jwt.SignOptions);
}

export async function register(body: RegisterDto): Promise<{
  token: string;
  user: { id: string; email: string; role: string };
}> {
  const existing = await prisma.user.findUnique({
    where: { email: body.email },
  });
  if (existing) throw new HttpException(409, "Email already registered");

  const passwordHash = await bcrypt.hash(body.password, config.BCRYPT_ROUNDS);
  const user = await prisma.user.create({
    data: {
      email: body.email,
      passwordHash,
      role: Role.ADMIN,
    },
  });

  const token = signToken({ userId: user.id, role: user.role });
  return {
    token,
    user: { id: user.id, email: user.email, role: user.role },
  };
}

export async function login(body: LoginDto): Promise<{
  token: string;
  user: { id: string; email: string; role: string };
}> {
  const user = await prisma.user.findUnique({
    where: { email: body.email },
  });
  if (!user || !user.isActive)
    throw new HttpException(401, "Invalid credentials");

  const valid = await bcrypt.compare(body.password, user.passwordHash);
  if (!valid) throw new HttpException(401, "Invalid credentials");

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  const token = signToken({ userId: user.id, role: user.role });
  return {
    token,
    user: { id: user.id, email: user.email, role: user.role },
  };
}

export async function getMe(userId: string): Promise<{
  id: string;
  email: string;
  role: string;
}> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true },
  });
  if (!user) throw new HttpException(404, "User not found");
  return user;
}
