// src/data/templates.ts
// 预置模板：人生/商业/运动/学习等初始目标树结构。

import { GoalScape, GoalNode, createGoalNode } from "./types";

export interface GoalTemplate {
  id: string;
  name: string;
  description: string;
  build: () => GoalScape;
}

export const TEMPLATES: GoalTemplate[] = [
  {
    id: "life",
    name: "Life Balance",
    description: "Health, Career, Relationships, Finance, Growth",
    build: () => ({
      version: 1,
      mainGoal: createGoalNode({
        title: "My Life",
        importance: 100,
        children: [
          createGoalNode({ title: "Health", importance: 25, children: [
            createGoalNode({ title: "Exercise", importance: 40 }),
            createGoalNode({ title: "Nutrition", importance: 35 }),
            createGoalNode({ title: "Sleep", importance: 25 }),
          ]}),
          createGoalNode({ title: "Career", importance: 25, children: [
            createGoalNode({ title: "Skills", importance: 50 }),
            createGoalNode({ title: "Projects", importance: 50 }),
          ]}),
          createGoalNode({ title: "Relationships", importance: 20, children: [
            createGoalNode({ title: "Family", importance: 50 }),
            createGoalNode({ title: "Friends", importance: 50 }),
          ]}),
          createGoalNode({ title: "Finance", importance: 15, children: [
            createGoalNode({ title: "Savings", importance: 50 }),
            createGoalNode({ title: "Investments", importance: 50 }),
          ]}),
          createGoalNode({ title: "Personal Growth", importance: 15, children: [
            createGoalNode({ title: "Reading", importance: 50 }),
            createGoalNode({ title: "Hobbies", importance: 50 }),
          ]}),
        ],
      }),
    }),
  },
  {
    id: "business",
    name: "Business Goals",
    description: "Revenue, Product, Team, Marketing, Operations",
    build: () => ({
      version: 1,
      mainGoal: createGoalNode({
        title: "Business",
        importance: 100,
        children: [
          createGoalNode({ title: "Revenue", importance: 30, children: [
            createGoalNode({ title: "New Customers", importance: 50 }),
            createGoalNode({ title: "Retention", importance: 50 }),
          ]}),
          createGoalNode({ title: "Product", importance: 25, children: [
            createGoalNode({ title: "Features", importance: 50 }),
            createGoalNode({ title: "Quality", importance: 50 }),
          ]}),
          createGoalNode({ title: "Team", importance: 20, children: [
            createGoalNode({ title: "Hiring", importance: 50 }),
            createGoalNode({ title: "Culture", importance: 50 }),
          ]}),
          createGoalNode({ title: "Marketing", importance: 15, children: [
            createGoalNode({ title: "Content", importance: 50 }),
            createGoalNode({ title: "Channels", importance: 50 }),
          ]}),
          createGoalNode({ title: "Operations", importance: 10 }),
        ],
      }),
    }),
  },
  {
    id: "fitness",
    name: "Fitness Goals",
    description: "Strength, Endurance, Flexibility, Nutrition, Recovery",
    build: () => ({
      version: 1,
      mainGoal: createGoalNode({
        title: "Fitness",
        importance: 100,
        children: [
          createGoalNode({ title: "Strength", importance: 30, children: [
            createGoalNode({ title: "Upper Body", importance: 50 }),
            createGoalNode({ title: "Lower Body", importance: 50 }),
          ]}),
          createGoalNode({ title: "Endurance", importance: 25, children: [
            createGoalNode({ title: "Running", importance: 50 }),
            createGoalNode({ title: "Swimming", importance: 50 }),
          ]}),
          createGoalNode({ title: "Flexibility", importance: 15 }),
          createGoalNode({ title: "Nutrition", importance: 20 }),
          createGoalNode({ title: "Recovery", importance: 10 }),
        ],
      }),
    }),
  },
  {
    id: "learning",
    name: "Learning Plan",
    description: "Courses, Practice, Projects, Community, Reflection",
    build: () => ({
      version: 1,
      mainGoal: createGoalNode({
        title: "Learning",
        importance: 100,
        children: [
          createGoalNode({ title: "Courses", importance: 30, children: [
            createGoalNode({ title: "Online", importance: 50 }),
            createGoalNode({ title: "Books", importance: 50 }),
          ]}),
          createGoalNode({ title: "Practice", importance: 30 }),
          createGoalNode({ title: "Projects", importance: 20 }),
          createGoalNode({ title: "Community", importance: 10 }),
          createGoalNode({ title: "Reflection", importance: 10 }),
        ],
      }),
    }),
  },
];

export function getTemplate(id: string): GoalTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
