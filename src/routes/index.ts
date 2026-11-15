import {
  RouteRecordRaw,
  createRouter,
  createWebHistory,
} from "vue-router"

import IndexPage from "../views/index-page/index-page.vue"

const routes: Array<RouteRecordRaw> = [
  {
    path: "/",
    component: IndexPage,
    name: "index",
    meta: {
      keepAlive: true,
    },
  },
  {
    path: "/create",
    redirect: "/",
  },
  {
    path: "/join",
    redirect: "/",
  },
  {
    path: "/room/:roomId",
    redirect: "/",
  },
  {
    path: "/contact",
    redirect: "/",
  },
  {
    path: "/:pathMatch(.*)*",
    redirect: "/",
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

export { router }
