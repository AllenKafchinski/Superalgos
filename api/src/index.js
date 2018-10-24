import '@babel/polyfill'
require('dotenv').config();
import express from 'express'
import createApolloServer from './ApolloServer'
import { formatError } from './errors'
import {
  Prisma,
  extractFragmentReplacements,
  forwardTo
} from 'prisma-binding'
import { makeExecutableSchema } from 'graphql-tools'
import { importSchema } from 'graphql-import'
import parser from 'fast-xml-parser'
import axios from 'axios'

import checkJwt from './auth/middleware/jwt'
import { getMember } from './auth/middleware/getMember'
import { validateIdToken } from './auth/validateIdToken'
import { schemaDirectives } from './directives'

import { sendTeamMemberInvite, sendTeamCreateConfirmation, verifyInviteToken } from './email/sendgrid'

import TEAMS_FRAGMENT from './graphql/TeamsFragment'
import TEAMS_CONNECTIONS_FRAGMENT from './graphql/TeamsConnectionsFragment'
import TEAM_FB_FRAGMENT from './graphql/TeamFBFragment'

import pubsub from './pubsub'
import { logger } from './logger'

const GRAPHQL_ENDPOINT = '/graphql'
const GRAPHQL_SUBSCRIPTIONS = '/graphql'
const PORT = 4001
const NODE_ENV = 'development'

const createMember = async function (ctx, info, idToken) {
  logger.info('createMember', idToken)
  const member = await ctx.db.mutation.upsertMember({
    where: {
      authId: idToken.sub,
    },
    create: {
      authId: idToken.sub,
      alias: idToken.nickname
    },
    update: {
      authId: idToken.sub,
      alias: idToken.nickname
    }
  }, info)
  return member
}

const ctxMember = ctx => ctx.request.user

const resolvers = {
  Query: {
    async member(parent, arg, ctx, info) {
      logger.info('member: ', parent, arg)
      return ctx.db.query.member({ where: { authId: arg.authId } }, info)
    },
    async currentMember(parent, args, ctx, info) {
      logger.info('currentMember: ', ctx.request.res.req.user, ctx.token)
      const authId = ctx.request.res.req.user.sub

      return ctx.db.query.member({ where: { authId } }, info)
    },
    teams(parent, args, ctx, info) {
      logger.info('teams: ', ctx.request.res)
      return ctx.db.query.teamsConnection({}, TEAMS_CONNECTIONS_FRAGMENT)
    },
    async teamById(parent, { id }, ctx, info) {
      return ctx.db.query.team({ where: { id } }, info)
    },
    async teamByName(parent, { name }, ctx, info) {
      return ctx.db.query.team({ where: { name: name } }, `{ name }`)
    },
    async teamWithRole(parent, { teamId, role }, ctx, info) {
      return ctx.db.query.teamsConnection({where: {AND: [{id: teamId},{members_some:{role: role}}]}, first:1}, info)
    },
    async teamsByOwner(parent, { ownerId }, ctx, info) {
      return ctx.db.query.teams({where: { owner: ownerId }, orderBy:'updatedAt_DESC'}, TEAMS_FRAGMENT)
    },
    async teamsByRole(parent, args, ctx, info) {
      const authId = ctx.request.user.sub
      let teamAdmin = await ctx.db.query.teams({where: {members_some: {OR: [{role: 'ADMIN'}, {role: 'OWNER'}], AND: [{member: {authId: authId}}]}}, orderBy: 'updatedAt_DESC'}, TEAMS_FRAGMENT)
      logger.info('teamsByRole teamAdmin: ', teamAdmin)
      return teamAdmin
    },
    async fbByTeamMember(parent, args, ctx, info) {
      logger.info('fbByTeamMember: ', args, ctx.request, ctx.request.res.req.user)
      const authId = ctx.request.user.sub
      let teamMemberFB = await ctx.db.query.teams({where: {members_some: {AND: [{member: {authId: authId}}]}}, orderBy: 'updatedAt_DESC'}, TEAM_FB_FRAGMENT)
      logger.info('fbByTeamMember response: ', await teamMemberFB[0])
      return teamMemberFB[0]
    },
    async owner(parent, args, ctx, info) {
      logger.info('resolver.query.owner ctx: ', ctxMember(ctx))
      return ctx.db.query.member({ where: { id: ctxMember(ctx).authId } }, info)
        .catch(err => {
          logger.debug('createTeam error: ', err)
          const errors = res.graphQLErrors.map((error) => {
            return error.message
          })
        })
    }
  },
  Mutation: {
    async authenticate(parent, { idToken }, ctx, info) {
      let memberToken = null
      try {
        memberToken = await validateIdToken(idToken)
        logger.info('authenticate.memberToken: ', await memberToken)
      } catch (err) {
        logger.debug('authenticat.validateIdToken err: ', err)
        throw new Error(err.message)
      }
      const authId = memberToken.sub
      let member = await ctx.db.query.member({ where: { authId } }, info)

      if (!member) {
        try {
          return createMember(ctx, info, memberToken)
        } catch (error) {
          throw new Error(error.message)
        }
      }
      return member
    },
    async sendMemberInviteSG(parent, { email, teamId }, ctx, info) {
      const team = await ctx.db.query.team({ where: { id: teamId } }, TEAMS_FRAGMENT)
      const addMember = await ctx.db.mutation.upsertTeamMembers({
        where:{email: email},
        create:{role:'MEMBER', email:email, team: {connect: {id: teamId}}, status:{create:{status: 'INVITED', reason: `Invited by ${team.members[0].member.alias}`}}},
        update:{role: 'MEMBER', email: email, team: {connect: {id: teamId}}, status:{create:{status: 'INVITED', reason: `Invite resent by ${team.members[0].member.alias}`}}}},
        `{ id }`)
      const sendInvite = await sendTeamMemberInvite(email, team)
      return sendInvite
    },
    async verifyTeamInvite(parent, { token }, ctx, info) {
      let verifiedToken = null
      let team = null
      try {
        verifiedToken = await verifyInviteToken(token)
        team = {
          email: verifiedToken.email,
          team: {
            slug: verifiedToken.team
          }
        }
        logger.info('verifyTeamInvite.token: ', await verifiedToken)
      } catch (err) {
        logger.debug('verifyTeamInvite. err: ', err)
        throw new Error(err.message)
      }
      return team
    },
    async createTeam(parent, { name, slug, botName, botSlug }, ctx, info) {
      logger.info('createTeam ctx.request.user:')
      logger.info(ctx.request.user)
      logger.info('createTeam ctx.request:')
      logger.info(ctx.request)
      const authId = ctx.request.user.sub

      const encodedAuthId = encodeURI(authId)
      const encodedURL = `https://users-api.advancedalgos.net/graphql?query=%7B%0A%20%20userByAuthId(authId:%20%22${authId}%22)%20%7B%0A%20%20%20%20id%0A%20%20%20%20email%0A%20%20%20%20alias%0A%20%20%7D%0A%7D%0A`
      const decodedURL = decodeURI(encodedURL)
      return getUser(authId)
        .then(async result => {
          logger.info('axios:')
          logger.info(result)

          const alias = result.data.users_UserByAuthId.alias
          const email = result.data.users_UserByAuthId.email
          const avatar = 'https://aadevelop.blob.core.windows.net/module-teams/module-default/aa-avatar-default.png'
          const banner = 'https://aadevelop.blob.core.windows.net/module-teams/module-default/aa-banner-default.png'

          const createTeamUrl = encodeURI(`${slug}/${name}/${alias}/${botSlug}/${botName}`)
          logger.info('createTeamUrl:')
          logger.info(JSON.stringify(await createTeamUrl))

          const platformUrl = 'https://develop.advancedalgos.net/AABrowserAPI/teamSetup/'
          // const platformUrl = 'http://localhost:1337/AABrowserAPI/teamSetup/'
          /*
          logger.info(`${platformUrl}${createTeamUrl}/${authId}`)
          const createPlatformTeam = await axios.get(`${platformUrl}${createTeamUrl}/${authId}`)
            .then((result) => {
              console.log('createPlatformTeam result:', result.data)
              if(result.data.message === 'Team Name already taken'){
                return result.data.message
              }
              if(result.data.result === 'Fail'){
                return result.data.message
              }
              return result
            })
            .catch(err =>{
              logger.debug('createPlatformTeam err:')
              logger.debug(err)
              throw new Error(err)
            })
          console.log('createPlatformTeam returned: ', await createPlatformTeam)
          if(await createPlatformTeam === 'Team Name already taken'){
            return createPlatformTeam
          }
          */
          const createTeam = await ctx.db.mutation.createTeam({ data: {name: name, slug: slug, owner: authId, members: {create: {member: {create: {authId: authId, alias: alias, visible:'true', status: { create: { status: 'ACTIVE', reason: `Created team ${name}`}}}}, role: 'OWNER'}}, profile: {create: {avatar: avatar, banner: banner}}, fb: {create: {name: botName, slug: botSlug, kind:'TRADER', avatar: avatar, status: {create: {status: 'ACTIVE', reason: "Cloned on team creation"}}}}, status: {create: {status: 'ACTIVE', reason:"Team created"}}} }, TEAMS_FRAGMENT)
            .catch((err) => {
              logger.debug(err, 'createTeam error: ')
              return err
            })

          // sendTeamCreateConfirmation(email, name, botName)

          return createTeam
        })
        .catch((err) => {
          logger.debug('createTeam error: ')
          return err
        })
    },
    async updateTeamProfile(parent, { slug, owner, description, motto, avatar, banner }, ctx, info) {
      return ctx.db.mutation.updateTeam({data:{profile: {update: {description: description, motto: motto, avatar: avatar, banner: banner}}}, where:{slug: slug}}, TEAMS_FRAGMENT)
        .catch((err) => {
          logger.debug('createTeam error: ', err)
          return err
        })
    },
    async updateFB(parent, { fbId, avatar}, ctx, info) {
      return ctx.db.mutation.updateFinancialBeings({data:{avatar:avatar}, where:{id:fbId}}, info)
        .catch((err) => {
          logger.debug('createTeam error: ', err)
          return err
        })
    },
    async deleteTeam(parent, { slug }, ctx, info) {
      return ctx.db.mutation.deleteTeam({ where: { slug } }, info)
        .catch((res) => {
          logger.info('deleteTeam error: ', res)
          const errors = res.graphQLErrors.map((error) => {
            return error.message
          })
        })
    }
  }
}

const getUser = authId => {
  logger.info('getUser')
  logger.info(authId)
  const API_URL = 'https://app-api.advancedalgos.net/graphql'
  return new Promise(resolve => {
    try {
      const result = axios.post(API_URL, {
        query: `query users_UserByAuthId($authId: String!) {
          users_UserByAuthId(authId: $authId){
            id
            alias
            email
          }
        }`,
        variables: {
          authId: authId
        }
      }, {
          headers: {
            'Content-Type': 'application/json'
          }
        })
        .then(result => {
          logger.info('getUser result')
          logger.info(result.data)
          resolve(result.data)
        })
        .catch(err => {
          logger.info('getUser err')
          logger.info(err)
          throw new Error(err)
        })

    } catch (error) {
      resolve(error)
    }
  })
}

const db = new Prisma({
  fragmentReplacements: extractFragmentReplacements(resolvers),
  typeDefs: 'src/generated/prisma.graphql',
  endpoint: process.env.PRISMA_ENDPOINT,
  secret: process.env.PRISMA_SECRET,
  debug: true
})

const app = express()

const connectionMiddlewares = [
  checkJwt,
  function (err, req, res, next) {
    logger.info('checkJwt: ', err, req.headers, req.user)
    if (err) {
      return res.status(201).send(err.message)
    } else {
      next()
    }
  },
  // (req, res, done) => getMember(req, res, done, db)
]

app.post(GRAPHQL_ENDPOINT, ...connectionMiddlewares)

const corsOptions = {
  "origin": "*",
  "methods": "GET,HEAD,PUT,PATCH,POST,DELETE",
  "preflightContinue": false,
  "optionsSuccessStatus": 204
}

const options = {
  port: 4001,
  cors: corsOptions,
  endpoint: '/graphql',
  subscriptions: '/graphql',
  playground: '/graphiql'
}

const server = createApolloServer(app, {
  graphqlEndpoint: GRAPHQL_ENDPOINT,
  subscriptionsEndpoint: GRAPHQL_SUBSCRIPTIONS,
  wsMiddlewares: connectionMiddlewares,
  apolloServerOptions: { formatError },
  typeDefs: importSchema('src/schema.graphql'),
  resolvers,
  resolverValidationOptions: { requireResolversForResolveType: false },
  schemaDirectives,
  context: req  => ({
    ...req ,
    token: req.headers,
    user: req.user,
    db,
    pubsub
  })
})

server.listen({ port: PORT }, () => {
  logger.info(
    `🚀 GraphQL Server is running on http://localhost:${PORT}${GRAPHQL_ENDPOINT} in "${NODE_ENV}" mode\n`
  )
})

module.exports= { createMember }
