import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { LiftWiseAuthGuard, type LiftWiseRequest } from "./liftwise-auth.guard";
import { LiftWiseService } from "./liftwise.service";

@Controller("liftwise")
@UseGuards(LiftWiseAuthGuard)
export class LiftWiseController {
  constructor(
    @Inject(LiftWiseService) private readonly liftwise: LiftWiseService,
  ) {}
  @Get("profile")
  profile(@Req() request: LiftWiseRequest) {
    return this.liftwise.profile(request.user);
  }
  @Post("profile")
  saveProfile(@Req() request: LiftWiseRequest, @Body() body: unknown) {
    return this.liftwise.saveProfile(request.user, body);
  }
  @Post("support-reports")
  supportReport(@Req() request: LiftWiseRequest, @Body() body: unknown) {
    return this.liftwise.submitSupportReport(request.user, body);
  }
  @Get("exercises")
  exercises(@Query("search") search?: string) {
    return this.liftwise.exercises(search);
  }
  @Get("exercises/:id/instructions")
  instructions(@Param("id") id: string) {
    return this.liftwise.instructions(id);
  }
  @Get("exercises/:id")
  exercise(@Param("id") id: string) {
    return this.liftwise.exercise(id);
  }
  @Get("workouts")
  workouts(@Req() request: LiftWiseRequest, @Query("limit") limit?: string) {
    return this.liftwise.workouts(request.user.uid, limit);
  }
  @Post("workouts")
  createWorkout(@Req() request: LiftWiseRequest, @Body() body: unknown) {
    return this.liftwise.createWorkout(request.user.uid, body);
  }
  @Get("workouts/:id")
  workout(@Req() request: LiftWiseRequest, @Param("id") id: string) {
    return this.liftwise.workout(request.user.uid, id);
  }
  @Post("workouts/:id/duplicate")
  duplicateWorkout(@Req() request: LiftWiseRequest, @Param("id") id: string) {
    return this.liftwise.duplicateWorkout(request.user.uid, id);
  }
  @Delete("workouts/:id")
  deleteWorkout(@Req() request: LiftWiseRequest, @Param("id") id: string) {
    return this.liftwise.deleteWorkout(request.user.uid, id);
  }
  @Get("workout-sessions/calendar")
  calendar(
    @Req() request: LiftWiseRequest,
    @Query("start") start: string,
    @Query("end") end: string,
  ) {
    return this.liftwise.calendar(request.user.uid, start, end);
  }
  @Get("workout-sessions/streak")
  streak(@Req() request: LiftWiseRequest) {
    return this.liftwise.streak(request.user.uid);
  }
  @Get("workout-sessions")
  sessions(@Req() request: LiftWiseRequest, @Query("limit") limit?: string) {
    return this.liftwise.sessions(request.user.uid, limit);
  }
  @Post("workout-sessions")
  createSession(@Req() request: LiftWiseRequest, @Body() body: unknown) {
    return this.liftwise.createSession(request.user.uid, body);
  }
  @Get("workout-sessions/:id")
  session(@Req() request: LiftWiseRequest, @Param("id") id: string) {
    return this.liftwise.session(request.user.uid, id);
  }
  @Get("home-stats")
  stats(
    @Req() request: LiftWiseRequest,
    @Query("start") start: string,
    @Query("end") end: string,
  ) {
    return this.liftwise.stats(request.user.uid, start, end);
  }
}
