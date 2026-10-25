import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { createHash } from "node:crypto";
import { LiftWiseAuthGuard, type LiftWiseRequest } from "./liftwise-auth.guard";
import { LiftWiseService } from "./liftwise.service";

@Controller("liftwise")
@UseGuards(LiftWiseAuthGuard)
export class LiftWiseController {
  constructor(
    @Inject(LiftWiseService) private readonly liftwise: LiftWiseService,
  ) {}
  @Get("profile")
  @Header("Cache-Control", "private, no-store")
  profile(@Req() request: LiftWiseRequest) {
    return this.liftwise.profile(request.user);
  }
  @Post("profile")
  @Header("Cache-Control", "private, no-store")
  saveProfile(@Req() request: LiftWiseRequest, @Body() body: unknown) {
    return this.liftwise.saveProfile(request.user, body);
  }
  @Patch("profile")
  @Header("Cache-Control", "private, no-store")
  patchProfile(@Req() request: LiftWiseRequest, @Body() body: unknown) {
    return this.liftwise.patchProfile(request.user, body);
  }
  @Post("support-reports")
  @Header("Cache-Control", "private, no-store")
  supportReport(@Req() request: LiftWiseRequest, @Body() body: unknown) {
    return this.liftwise.submitSupportReport(request.user, body);
  }
  @Get("exercises")
  @Header("Cache-Control", "private, no-store")
  async exercises(@Req() request: LiftWiseRequest, @Res({ passthrough: true }) response: Response, @Query("search") search?: string) {
    const records = await this.liftwise.exercises(search);
    const etag = `"${createHash("sha256").update(JSON.stringify(records)).digest("hex")}"`;
    response.setHeader("ETag", etag);
    response.vary("Authorization");
    if (request.headers["if-none-match"] === etag) {
      response.status(304);
      return;
    }
    return records;
  }
  @Get("exercises/:id/instructions")
  @Header("Cache-Control", "private, no-store")
  instructions(@Param("id") id: string, @Req() request: LiftWiseRequest) {
    return this.liftwise.instructions(id, request.user.uid);
  }
  @Get("exercises/:id")
  @Header("Cache-Control", "private, no-store")
  exercise(@Param("id") id: string) {
    return this.liftwise.exercise(id);
  }
  @Get("exercise-bookmarks")
  @Header("Cache-Control", "private, no-store")
  bookmarks(@Req() request: LiftWiseRequest) {
    return this.liftwise.bookmarks(request.user.uid);
  }
  @Put("exercise-bookmarks/:id")
  @Header("Cache-Control", "private, no-store")
  saveBookmark(@Req() request: LiftWiseRequest, @Param("id") id: string) {
    return this.liftwise.saveBookmark(request.user.uid, id);
  }
  @Delete("exercise-bookmarks/:id")
  @Header("Cache-Control", "private, no-store")
  deleteBookmark(@Req() request: LiftWiseRequest, @Param("id") id: string) {
    return this.liftwise.deleteBookmark(request.user.uid, id);
  }
  @Get("workouts")
  @Header("Cache-Control", "private, no-store")
  workouts(@Req() request: LiftWiseRequest, @Query("limit") limit?: string) {
    return this.liftwise.workouts(request.user.uid, limit);
  }
  @Post("workouts")
  @Header("Cache-Control", "private, no-store")
  createWorkout(@Req() request: LiftWiseRequest, @Body() body: unknown) {
    return this.liftwise.createWorkout(request.user.uid, body);
  }
  @Get("workouts/page")
  @Header("Cache-Control", "private, no-store")
  workoutPage(@Req() request: LiftWiseRequest, @Query("limit") limit?: string, @Query("cursor") cursor?: string) {
    return this.liftwise.workoutPage(request.user.uid, limit, cursor);
  }
  @Get("workouts/:id")
  @Header("Cache-Control", "private, no-store")
  workout(@Req() request: LiftWiseRequest, @Param("id") id: string) {
    return this.liftwise.workout(request.user.uid, id);
  }
  @Patch("workouts/:id/exercise-order")
  @Header("Cache-Control", "private, no-store")
  reorderExercises(
    @Req() request: LiftWiseRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.liftwise.reorderExercises(request.user.uid, id, body);
  }
  @Patch("workouts/:id/cover")
  @Header("Cache-Control", "private, no-store")
  changeWorkoutCover(
    @Req() request: LiftWiseRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.liftwise.changeWorkoutCover(request.user.uid, id, body);
  }
  @Post("workouts/:id/duplicate")
  @Header("Cache-Control", "private, no-store")
  duplicateWorkout(@Req() request: LiftWiseRequest, @Param("id") id: string) {
    return this.liftwise.duplicateWorkout(request.user.uid, id);
  }
  @Delete("workouts/:id")
  @Header("Cache-Control", "private, no-store")
  deleteWorkout(@Req() request: LiftWiseRequest, @Param("id") id: string) {
    return this.liftwise.deleteWorkout(request.user.uid, id);
  }
  @Get("workout-sessions/calendar")
  @Header("Cache-Control", "private, no-store")
  calendar(
    @Req() request: LiftWiseRequest,
    @Query("start") start: string,
    @Query("end") end: string,
  ) {
    return this.liftwise.calendar(request.user.uid, start, end);
  }
  @Get("workout-sessions/streak")
  @Header("Cache-Control", "private, no-store")
  streak(@Req() request: LiftWiseRequest) {
    return this.liftwise.streak(request.user.uid);
  }
  @Get("workout-sessions/page")
  @Header("Cache-Control", "private, no-store")
  sessionPage(
    @Req() request: LiftWiseRequest,
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
    @Query("start") start?: string,
    @Query("end") end?: string,
  ) {
    return this.liftwise.sessionPage(
      request.user.uid,
      limit,
      cursor,
      start,
      end,
    );
  }
  @Get("workout-sessions")
  @Header("Cache-Control", "private, no-store")
  sessions(@Req() request: LiftWiseRequest, @Query("limit") limit?: string) {
    return this.liftwise.sessions(request.user.uid, limit);
  }
  @Post("workout-sessions")
  @Header("Cache-Control", "private, no-store")
  createSession(@Req() request: LiftWiseRequest, @Body() body: unknown) {
    return this.liftwise.createSession(request.user.uid, body);
  }
  @Get("workout-sessions/:id")
  @Header("Cache-Control", "private, no-store")
  session(@Req() request: LiftWiseRequest, @Param("id") id: string) {
    return this.liftwise.session(request.user.uid, id);
  }
  @Get("home-stats")
  @Header("Cache-Control", "private, no-store")
  stats(
    @Req() request: LiftWiseRequest,
    @Query("start") start: string,
    @Query("end") end: string,
  ) {
    return this.liftwise.stats(request.user.uid, start, end);
  }
}
