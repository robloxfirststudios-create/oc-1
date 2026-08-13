import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Interaction,
  ModalBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Message,
  type ModalSubmitInteraction,
  type Role,
  type StringSelectMenuInteraction,
} from "discord.js";
import crypto from "node:crypto";
import {
  addAnonymousDmLog,
  addWarning,
  createCase,
  createSubmission,
  createTicket,
  getAutoReactions,
  getGuildConfig,
  getReactionRole,
  getTicket,
  getWarnings,
  saveGuildConfig,
  saveReactionRole,
  updateSubmissionStatus,
  updateTicket,
  upsertAutoReaction,
  type GuildConfig,
} from "./database";
import { logger } from "./lib/logger";

const prefix = "!";
const cooldowns = new Map<string, number>();
const embedDrafts = new Map<string, { title: string; description: string; colour: string; footer?: string }>();
const startedAt = Date.now();

const colors = {
  primary: 0x5865f2,
  success: 0x57f287,
  danger: 0xed4245,
  warning: 0xfee75c,
  neutral: 0x2b2d31,
};

function color(value: string | undefined, fallback = colors.primary) {
  if (!value) return fallback;
  const normalized = value.replace("#", "");
  const parsed = Number.parseInt(normalized, 16);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function baseEmbed(title: string, description: string, colour = colors.primary) {
  return new EmbedBuilder()
    .setColor(colour)
    .setTitle(title)
    .setDescription(description)
    .setTimestamp();
}

function errorEmbed(message: string) {
  return new EmbedBuilder().setColor(colors.danger).setDescription(`❌ ${message}`);
}

function okEmbed(message: string) {
  return new EmbedBuilder().setColor(colors.success).setDescription(`✅ ${message}`);
}

function isStaff(member: GuildMember, config: GuildConfig) {
  return member.permissions.has(PermissionFlagsBits.ManageGuild)
    || member.permissions.has(PermissionFlagsBits.Administrator)
    || config.staffRoles.some((id) => member.roles.cache.has(id))
    || config.administratorRoles.some((id) => member.roles.cache.has(id))
    || config.moderatorRoles.some((id) => member.roles.cache.has(id));
}

function isAdmin(member: GuildMember, config: GuildConfig) {
  return member.permissions.has(PermissionFlagsBits.Administrator)
    || member.guild.ownerId === member.id
    || config.administratorRoles.some((id) => member.roles.cache.has(id));
}

function hasAnyRole(member: GuildMember, roleIds: string[]) {
  return roleIds.some((id) => member.roles.cache.has(id));
}

function allowed(member: GuildMember, config: GuildConfig, level: "staff" | "moderator" | "admin" | "owner") {
  if (level === "owner") return member.guild.ownerId === member.id;
  if (level === "admin") return isAdmin(member, config);
  if (level === "moderator") {
    return isStaff(member, config) || member.permissions.has(PermissionFlagsBits.ModerateMembers);
  }
  return isStaff(member, config);
}

function parseTarget(message: Message, raw?: string) {
  const mention = message.mentions.members?.first();
  if (mention) return mention;
  const id = raw?.replace(/[<@!>]/g, "");
  return id ? message.guild?.members.cache.get(id) : undefined;
}

function channelFor(guild: Message["guild"], id: string | undefined) {
  if (!guild || !id) return undefined;
  return guild.channels.cache.get(id);
}

async function sendLog(guild: Message["guild"], channelId: string | undefined, embed: EmbedBuilder) {
  if (!guild || !channelId) return;
  const channel = channelFor(guild, channelId);
  if (channel?.isTextBased()) await channel.send({ embeds: [embed] }).catch(() => undefined);
}

function commandCooldown(userId: string, name: string, ms = 5_000) {
  const key = `${userId}:${name}`;
  const last = cooldowns.get(key) ?? 0;
  if (Date.now() - last < ms) return false;
  cooldowns.set(key, Date.now());
  return true;
}

function setupRow() {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("setup:select")
      .setPlaceholder("Choose a setup area")
      .addOptions(
        { label: "Overview", value: "overview", description: "Show the current configuration" },
        { label: "Role settings", value: "roles", description: "Set support, staff, moderator, and auto roles" },
        { label: "Channel settings", value: "channels", description: "Set logs, reports, tickets, and welcome channels" },
        { label: "Welcome settings", value: "welcome", description: "Configure the join message" },
        { label: "Colour settings", value: "colours", description: "Set the bot's embed colours" },
      ),
  );
}

function reportButtons(kind: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${kind}:reviewed`).setLabel("Reviewed").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${kind}:attention`).setLabel("Needs attention").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${kind}:important`).setLabel("Mark important").setStyle(ButtonStyle.Success),
  );
}

function makeModal(id: string, title: string, fields: Array<{ id: string; label: string; placeholder: string; required?: boolean; style?: TextInputStyle }>) {
  const modal = new ModalBuilder().setCustomId(id).setTitle(title);
  const rows = fields.slice(0, 5).map((field) =>
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId(field.id)
        .setLabel(field.label)
        .setPlaceholder(field.placeholder)
        .setRequired(field.required ?? true)
        .setStyle(field.style ?? TextInputStyle.Short),
    ),
  );
  return modal.addComponents(...rows);
}

function modalValue(interaction: ModalSubmitInteraction, id: string) {
  return interaction.fields.getTextInputValue(id).trim();
}

async function showSubmissionModal(interaction: ButtonInteraction, kind: "tester" | "devreport" | "bug" | "suggest" | "apply") {
  if (kind === "tester") {
    await interaction.showModal(makeModal("submit:tester", "Tester report", [
      { id: "game", label: "Game / server", placeholder: "ER:LC training server" },
      { id: "feature", label: "Feature tested", placeholder: "Describe the feature" },
      { id: "result", label: "Result", placeholder: "Passed, failed, or partially passed" },
      { id: "bugs", label: "Bugs found", placeholder: "None, or describe what happened", required: false, style: TextInputStyle.Paragraph },
      { id: "severity", label: "Severity", placeholder: "Low, medium, or high" },
    ]));
    return;
  }
  if (kind === "devreport") {
    await interaction.showModal(makeModal("submit:devreport", "Developer progress", [
      { id: "project", label: "Project / feature", placeholder: "What are you working on?" },
      { id: "progress", label: "Current progress", placeholder: "What is the current state?", style: TextInputStyle.Paragraph },
      { id: "completed", label: "Completed work", placeholder: "What is finished?", style: TextInputStyle.Paragraph },
      { id: "remaining", label: "Work remaining", placeholder: "What is left?", style: TextInputStyle.Paragraph },
      { id: "issues", label: "Problems / ETA", placeholder: "Issues and estimated completion", required: false, style: TextInputStyle.Paragraph },
    ]));
    return;
  }
  if (kind === "bug") {
    await interaction.showModal(makeModal("submit:bug", "Bug report", [
      { id: "bug", label: "Bug", placeholder: "What went wrong?", style: TextInputStyle.Paragraph },
      { id: "location", label: "Location", placeholder: "Where did it happen?" },
      { id: "steps", label: "Steps to reproduce", placeholder: "How can staff reproduce it?", style: TextInputStyle.Paragraph },
      { id: "expected", label: "Expected result", placeholder: "What should have happened?", style: TextInputStyle.Paragraph },
      { id: "actual", label: "Actual result / severity", placeholder: "What happened and how severe is it?", style: TextInputStyle.Paragraph },
    ]));
    return;
  }
  if (kind === "suggest") {
    await interaction.showModal(makeModal("submit:suggest", "Community suggestion", [
      { id: "suggestion", label: "Suggestion", placeholder: "What would improve the community?", style: TextInputStyle.Paragraph },
      { id: "reason", label: "Why it helps", placeholder: "Tell staff why this would be useful", style: TextInputStyle.Paragraph },
    ]));
    return;
  }
  await interaction.showModal(makeModal("submit:apply", "Staff application", [
    { id: "roblox", label: "Roblox username", placeholder: "Your Roblox username" },
    { id: "age", label: "Age", placeholder: "Your age" },
    { id: "experience", label: "Previous experience", placeholder: "Relevant experience", style: TextInputStyle.Paragraph },
    { id: "why", label: "Why should we choose you?", placeholder: "Your answer", style: TextInputStyle.Paragraph },
    { id: "extra", label: "Additional information", placeholder: "Anything else?", required: false, style: TextInputStyle.Paragraph },
  ]));
}

async function postSubmission(
  interaction: ModalSubmitInteraction,
  kind: string,
  title: string,
  fields: Record<string, string>,
  channelId: string | undefined,
  config: GuildConfig,
) {
  const destination = channelFor(interaction.guild, channelId) ?? interaction.channel;
  if (!destination?.isSendable()) {
    await interaction.reply({ embeds: [errorEmbed("No valid destination channel is configured.")], ephemeral: true });
    return;
  }
  const embed = baseEmbed(title, `Submitted by <@${interaction.user.id}>`, color(config.colours.primary))
    .setAuthor({ name: interaction.user.username, iconURL: interaction.user.displayAvatarURL() });
  for (const [key, value] of Object.entries(fields)) {
    embed.addFields({ name: key, value: value.slice(0, 1024) || "—", inline: key.length < 20 });
  }
  const sent = await destination.send({ embeds: [embed], components: [reportButtons(kind)] });
  if (kind === "suggest") {
    await sent.react("👍").catch(() => undefined);
    await sent.react("👎").catch(() => undefined);
  }
  createSubmission(interaction.guildId!, kind, interaction.user.id, fields, sent.id, destination.id);
  await interaction.reply({ embeds: [okEmbed("Your submission was sent to the staff team.")], ephemeral: true });
}

async function handleSetup(interaction: StringSelectMenuInteraction, value: string) {
  if (!interaction.guild || !interaction.member || !("permissions" in interaction.member)) return;
  const member = interaction.member as GuildMember;
  const config = getGuildConfig(interaction.guild.id);
  if (!isAdmin(member, config)) {
    await interaction.reply({ embeds: [errorEmbed("Only server administrators can change bot configuration.")], ephemeral: true });
    return;
  }
  if (value === "overview") {
    const roleCount = config.staffRoles.length + config.moderatorRoles.length + config.supportRoles.length;
    const channelCount = Object.values(config.channels).filter(Boolean).length;
    await interaction.reply({
      embeds: [baseEmbed("Configuration overview", `Prefix: \`${config.prefix}\`\nRoles configured: **${roleCount}**\nChannels configured: **${channelCount}**\nWelcome system: **${config.welcome.enabled ? "enabled" : "disabled"}**`)],
      ephemeral: true,
    });
    return;
  }
  const fields = value === "roles"
    ? [
        { id: "staff", label: "Staff role IDs", placeholder: "IDs separated by commas; blank keeps current", required: false },
        { id: "moderator", label: "Moderator role IDs", placeholder: "IDs separated by commas", required: false },
        { id: "support", label: "Support role IDs", placeholder: "IDs separated by commas", required: false },
        { id: "auto", label: "Auto-role IDs", placeholder: "IDs separated by commas", required: false },
      ]
    : value === "channels"
      ? [
          { id: "ticketLog", label: "Ticket log channel ID", placeholder: "Channel ID", required: false },
          { id: "moderationLog", label: "Moderation log channel ID", placeholder: "Channel ID", required: false },
          { id: "testerReport", label: "Tester report channel ID", placeholder: "Channel ID", required: false },
          { id: "developerReport", label: "Developer report channel ID", placeholder: "Channel ID", required: false },
          { id: "welcome", label: "Welcome channel ID", placeholder: "Channel ID", required: false },
        ]
      : value === "welcome"
        ? [
            { id: "channel", label: "Welcome channel ID", placeholder: "Channel ID", required: true },
            { id: "message", label: "Welcome message", placeholder: "Use {user}, {server}, and {count}", required: true, style: TextInputStyle.Paragraph },
          ]
        : [
            { id: "primary", label: "Primary colour", placeholder: "#5865F2", required: true },
            { id: "success", label: "Success colour", placeholder: "#57F287", required: true },
            { id: "danger", label: "Danger colour", placeholder: "#ED4245", required: true },
            { id: "warning", label: "Warning colour", placeholder: "#FEE75C", required: true },
          ];
  await interaction.showModal(makeModal(`setup:${value}`, `Configure ${value}`, fields));
}

async function handleButton(interaction: ButtonInteraction) {
  if (!interaction.guild) return;
  const [kind, action] = interaction.customId.split(":");
  const config = getGuildConfig(interaction.guild.id);
  const member = interaction.member as GuildMember;

  if (["tester", "devreport", "bug", "suggest", "apply"].includes(kind) && action === "open") {
    await showSubmissionModal(interaction, kind as "tester" | "devreport" | "bug" | "suggest" | "apply");
    return;
  }
  if (kind === "embed" && action === "open") {
    await interaction.showModal(makeModal("embed:build", "Embed builder", [
      { id: "title", label: "Title", placeholder: "Announcement title" },
      { id: "description", label: "Description", placeholder: "Write the embed content", style: TextInputStyle.Paragraph },
      { id: "colour", label: "Colour", placeholder: "#5865F2" },
      { id: "footer", label: "Footer", placeholder: "Optional footer", required: false },
    ]));
    return;
  }
  if (kind === "embed") {
    const draft = embedDrafts.get(interaction.user.id);
    if (action === "send" && draft && interaction.channel?.isSendable()) {
      const embed = new EmbedBuilder()
        .setColor(color(draft.colour))
        .setTitle(draft.title)
        .setDescription(draft.description)
        .setFooter({ text: draft.footer || "Built with Orbit Management" });
      await interaction.channel.send({ embeds: [embed] });
      embedDrafts.delete(interaction.user.id);
      await interaction.update({ content: "Embed sent.", components: [] });
      return;
    }
    if (action === "clear") {
      embedDrafts.delete(interaction.user.id);
      await interaction.update({ content: "Embed draft cleared.", embeds: [], components: [] });
      return;
    }
  }
  if (kind === "ticket") {
    if (action === "create") {
      if (!commandCooldown(interaction.user.id, "ticket", 30_000)) {
        await interaction.reply({ embeds: [errorEmbed("Please wait before opening another ticket.")], ephemeral: true });
        return;
      }
      const existing = interaction.guild.channels.cache.find((channel) =>
        channel.type === ChannelType.GuildText && channel.name.endsWith(interaction.user.id.slice(-6)),
      );
      if (existing) {
        await interaction.reply({ embeds: [errorEmbed(`You already have an open ticket: ${existing}`)], ephemeral: true });
        return;
      }
      const overwrites = [
        { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        ...config.supportRoles.map((id) => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] })),
      ];
      const channel = await interaction.guild.channels.create({
        name: `ticket-${interaction.user.id.slice(-6)}`,
        type: ChannelType.GuildText,
        parent: config.channels.ticketCategory,
        permissionOverwrites: overwrites,
      }).catch(() => undefined);
      if (!channel || !channel.isTextBased()) {
        await interaction.reply({ embeds: [errorEmbed("I could not create the ticket channel. Check my Manage Channels and Manage Roles permissions.")], ephemeral: true });
        return;
      }
      createTicket(interaction.guild.id, channel.id, interaction.user.id);
      await channel.send({
        content: `<@${interaction.user.id}> ${config.supportRoles.map((id) => `<@&${id}>`).join(" ")}`,
        embeds: [baseEmbed("Ticket opened", "Please explain what you need help with. A support member will be with you shortly.")],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("ticket:claim").setLabel("Claim").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("ticket:close").setLabel("Close").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId("ticket:add").setLabel("Add user").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("ticket:transcript").setLabel("Transcript").setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
      await interaction.reply({ embeds: [okEmbed(`Your private ticket is ready: ${channel}`)], ephemeral: true });
      await sendLog(interaction.guild, config.channels.ticketLog, baseEmbed("Ticket created", `${channel} opened by <@${interaction.user.id}>`));
      return;
    }
    const ticket = getTicket(interaction.channelId);
    if (!ticket) {
      await interaction.reply({ embeds: [errorEmbed("This channel is not a tracked ticket.")], ephemeral: true });
      return;
    }
    if (action === "claim") {
      if (!allowed(member, config, "staff")) {
        await interaction.reply({ embeds: [errorEmbed("Only configured staff can claim tickets.")], ephemeral: true });
        return;
      }
      updateTicket(interaction.channelId, { claimedBy: interaction.user.id });
      await interaction.reply({ embeds: [okEmbed(`Ticket claimed by <@${interaction.user.id}>.`)] });
      return;
    }
    if (action === "close") {
      if (!allowed(member, config, "staff") && ticket.creator_id !== interaction.user.id) {
        await interaction.reply({ embeds: [errorEmbed("Only the ticket creator or staff can close this ticket.")], ephemeral: true });
        return;
      }
      updateTicket(interaction.channelId, { status: "closed" });
      await interaction.reply({ embeds: [okEmbed("Ticket closed. This channel will be deleted in a few seconds.")] });
      await sendLog(interaction.guild, config.channels.ticketLog, baseEmbed("Ticket closed", `${interaction.channel} closed by <@${interaction.user.id}>.`));
      setTimeout(() => interaction.channel?.delete().catch(() => undefined), 4_000);
      return;
    }
    if (action === "add") {
      await interaction.showModal(makeModal("ticket:add-user", "Add a ticket member", [
        { id: "user", label: "User ID or mention", placeholder: "Discord user ID" },
      ]));
      return;
    }
    if (action === "transcript") {
      if (!interaction.channel?.isTextBased()) return;
      const messages = await interaction.channel.messages.fetch({ limit: 100 });
      const transcript = [...messages.values()].reverse().map((message) =>
        `[${message.createdAt.toISOString()}] ${message.author.tag}: ${message.cleanContent}`,
      ).join("\n");
      await interaction.reply({ files: [{ attachment: Buffer.from(transcript || "No messages."), name: `transcript-${interaction.channelId}.txt` }], ephemeral: true });
      return;
    }
  }
  if (["tester", "devreport", "bug", "suggest", "apply"].includes(kind) && action && action !== "open") {
    if (!allowed(member, config, "staff")) {
      await interaction.reply({ embeds: [errorEmbed("Only configured staff can review submissions.")], ephemeral: true });
      return;
    }
    const statuses: Record<string, string> = { reviewed: "Reviewed", attention: "Needs attention", important: "Important" };
    updateSubmissionStatus(interaction.message.id, statuses[action] ?? action);
    const updated = EmbedBuilder.from(interaction.message.embeds[0] ?? baseEmbed("Submission", ""))
      .setFooter({ text: `Status: ${statuses[action] ?? action} • Updated by ${interaction.user.tag}` });
    await interaction.update({ embeds: [updated], components: [] });
    return;
  }
  if (kind === "reactionrole") {
    const role = interaction.guild.roles.cache.get(action);
    if (!role || role.position >= interaction.guild.members.me!.roles.highest.position) {
      await interaction.reply({ embeds: [errorEmbed("That role is missing or higher than my highest role.")], ephemeral: true });
      return;
    }
    if (member.roles.cache.has(role.id)) {
      await member.roles.remove(role).catch(() => undefined);
      await interaction.reply({ embeds: [okEmbed(`Removed **${role.name}** from you.`)], ephemeral: true });
    } else {
      await member.roles.add(role).catch(() => undefined);
      await interaction.reply({ embeds: [okEmbed(`Added **${role.name}** to you.`)], ephemeral: true });
    }
  }
}

async function handleModal(interaction: ModalSubmitInteraction) {
  if (!interaction.guild) return;
  const config = getGuildConfig(interaction.guild.id);
  if (interaction.customId === "submit:tester") {
    await postSubmission(interaction, "tester", "Tester report", {
      "Game / server": modalValue(interaction, "game"),
      "Feature": modalValue(interaction, "feature"),
      "Result": modalValue(interaction, "result"),
      "Bugs": modalValue(interaction, "bugs"),
      "Severity": modalValue(interaction, "severity"),
    }, config.channels.testerReport, config);
    return;
  }
  if (interaction.customId === "submit:devreport") {
    await postSubmission(interaction, "devreport", "Developer progress report", {
      "Project": modalValue(interaction, "project"),
      "Current progress": modalValue(interaction, "progress"),
      "Completed": modalValue(interaction, "completed"),
      "Remaining": modalValue(interaction, "remaining"),
      "Issues / ETA": modalValue(interaction, "issues"),
    }, config.channels.developerReport, config);
    return;
  }
  if (interaction.customId === "submit:bug") {
    await postSubmission(interaction, "bug", "Bug report", {
      "Bug": modalValue(interaction, "bug"),
      "Location": modalValue(interaction, "location"),
      "Steps": modalValue(interaction, "steps"),
      "Expected": modalValue(interaction, "expected"),
      "Actual / severity": modalValue(interaction, "actual"),
    }, config.channels.bug, config);
    return;
  }
  if (interaction.customId === "submit:suggest") {
    await postSubmission(interaction, "suggest", "Community suggestion", {
      "Suggestion": modalValue(interaction, "suggestion"),
      "Why it helps": modalValue(interaction, "reason"),
    }, config.channels.suggestion, config);
    return;
  }
  if (interaction.customId === "submit:apply") {
    await postSubmission(interaction, "apply", "Staff application", {
      "Roblox username": modalValue(interaction, "roblox"),
      "Age": modalValue(interaction, "age"),
      "Experience": modalValue(interaction, "experience"),
      "Why choose me": modalValue(interaction, "why"),
      "Additional information": modalValue(interaction, "extra"),
    }, config.channels.application, config);
    return;
  }
  if (interaction.customId.startsWith("setup:")) {
    const area = interaction.customId.split(":")[1];
    const member = interaction.member as GuildMember;
    if (!isAdmin(member, config)) {
      await interaction.reply({ embeds: [errorEmbed("Only server administrators can change bot configuration.")], ephemeral: true });
      return;
    }
    if (area === "roles") {
      const parse = (id: string) => id.split(",").map((item) => item.trim()).filter(Boolean);
      const next = {
        ...config,
        staffRoles: parse(modalValue(interaction, "staff")),
        moderatorRoles: parse(modalValue(interaction, "moderator")),
        supportRoles: parse(modalValue(interaction, "support")),
        autoRoles: parse(modalValue(interaction, "auto")),
      };
      saveGuildConfig(interaction.guild.id, next);
      await interaction.reply({ embeds: [okEmbed("Role settings saved.")], ephemeral: true });
      return;
    }
    if (area === "channels") {
      const next = { ...config, channels: { ...config.channels } };
      for (const key of ["ticketLog", "moderationLog", "testerReport", "developerReport", "welcome"] as const) {
        const value = modalValue(interaction, key);
        if (value) next.channels[key] = value;
      }
      saveGuildConfig(interaction.guild.id, next);
      await interaction.reply({ embeds: [okEmbed("Channel settings saved.")], ephemeral: true });
      return;
    }
    if (area === "welcome") {
      const next = { ...config, channels: { ...config.channels, welcome: modalValue(interaction, "channel") }, welcome: { ...config.welcome, enabled: true, message: modalValue(interaction, "message") } };
      saveGuildConfig(interaction.guild.id, next);
      await interaction.reply({ embeds: [okEmbed("Welcome settings saved and enabled.")], ephemeral: true });
      return;
    }
    const next = { ...config, colours: { primary: modalValue(interaction, "primary"), success: modalValue(interaction, "success"), danger: modalValue(interaction, "danger"), warning: modalValue(interaction, "warning") } };
    saveGuildConfig(interaction.guild.id, next);
    await interaction.reply({ embeds: [okEmbed("Embed colours saved.")], ephemeral: true });
    return;
  }
  if (interaction.customId === "embed:build") {
    const draft = {
      title: modalValue(interaction, "title"),
      description: modalValue(interaction, "description"),
      colour: modalValue(interaction, "colour"),
      footer: modalValue(interaction, "footer"),
    };
    embedDrafts.set(interaction.user.id, draft);
    const preview = new EmbedBuilder().setColor(color(draft.colour)).setTitle(draft.title).setDescription(draft.description).setFooter({ text: draft.footer || "Built with Orbit Management" });
    await interaction.reply({
      content: "Preview only — send it when it looks right.",
      embeds: [preview],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("embed:send").setLabel("Send").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("embed:clear").setLabel("Clear").setStyle(ButtonStyle.Secondary),
      )],
      ephemeral: true,
    });
    return;
  }
  if (interaction.customId === "ticket:add-user") {
    if (!interaction.channelId) {
      await interaction.reply({ embeds: [errorEmbed("This interaction is not in a ticket channel.")], ephemeral: true });
      return;
    }
    const ticket = getTicket(interaction.channelId);
    const member = interaction.guild.members.cache.get(modalValue(interaction, "user").replace(/[<@!>]/g, ""));
    if (!ticket || !member || !interaction.channel || !("permissionOverwrites" in interaction.channel)) {
      await interaction.reply({ embeds: [errorEmbed("I could not find that user or ticket.")], ephemeral: true });
      return;
    }
    await interaction.channel.permissionOverwrites.edit(member.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
    await interaction.reply({ embeds: [okEmbed(`${member} was added to the ticket.`)] });
  }
}

async function handleSelect(interaction: Interaction) {
  if (!interaction.isStringSelectMenu()) return;
  if (interaction.customId === "setup:select") {
    await handleSetup(interaction, interaction.values[0]);
  }
}

function helpEmbed() {
  return baseEmbed("Orbit Management", "Professional tools for community owners and staff teams.")
    .addFields(
      { name: "General", value: "`!ping` `!serverinfo` `!userinfo` `!botinfo` `!help`" },
      { name: "Reports", value: "`!ticket` `!tester` `!devreport` `!bug` `!suggest` `!apply`" },
      { name: "Moderation", value: "`!warn` `!warnings` `!clear` `!kick` `!ban` `!timeout` `!lock` `!slowmode`" },
      { name: "Staff", value: "`!embed` `!dm` `!say` `!announce` `!poll` `!reactionrole`" },
      { name: "Administration", value: "`!setup` `!autorole` `!autoreaction` `!welcome`" },
    )
    .setFooter({ text: "Prefix: ! • Use Discord permissions and configured roles together" });
}

async function executeCommand(message: Message, name: string, args: string[]) {
  if (!message.guild || message.author.bot) return;
  if (!message.channel.isSendable()) return;
  const config = getGuildConfig(message.guild.id);
  const member = message.member!;
  const reply = (payload: Parameters<Message["reply"]>[0]) => message.reply(payload).catch(() => undefined);

  if (name === "help") {
    await reply({ embeds: [helpEmbed()] });
    return;
  }
  if (name === "ping") {
    await reply({ embeds: [okEmbed(`Pong. Gateway latency: **${message.client.ws.ping}ms**`)] });
    return;
  }
  if (name === "uptime" || name === "botinfo") {
    const uptime = Math.floor((Date.now() - startedAt) / 1000);
    await reply({ embeds: [baseEmbed("Bot status", `Uptime: **${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s**\nServers: **${message.client.guilds.cache.size}**\nDatabase: **SQLite / WAL**`)] });
    return;
  }
  if (name === "serverinfo") {
    await reply({ embeds: [baseEmbed(message.guild.name, `Members: **${message.guild.memberCount}**\nChannels: **${message.guild.channels.cache.size}**\nCreated: <t:${Math.floor(message.guild.createdTimestamp / 1000)}:D>`).setThumbnail(message.guild.iconURL() ?? "")] });
    return;
  }
  if (name === "userinfo") {
    const target = parseTarget(message, args[0]) ?? member;
    await reply({ embeds: [baseEmbed(`User information`, `${target}\nUsername: **${target.user.tag}**\nJoined: <t:${Math.floor((target.joinedTimestamp ?? Date.now()) / 1000)}:R>\nRoles: ${target.roles.cache.filter((role) => role.id !== message.guild!.id).map((role) => role.name).slice(0, 10).join(", ") || "None"}`).setThumbnail(target.displayAvatarURL())] });
    return;
  }
  if (name === "avatar") {
    const target = parseTarget(message, args[0]) ?? member;
    await reply({ embeds: [baseEmbed(`${target.user.tag}'s avatar`, `[Open full size](${target.displayAvatarURL({ size: 1024 })})`).setImage(target.displayAvatarURL({ size: 1024 }))] });
    return;
  }
  if (name === "roleinfo") {
    const role = message.mentions.roles.first() ?? message.guild.roles.cache.get(args[0]);
    if (!role) {
      await reply({ embeds: [errorEmbed("Usage: `!roleinfo @Role`")] });
      return;
    }
    await reply({ embeds: [baseEmbed(`Role information`, `Name: **${role.name}**\nMembers: **${role.members.size}**\nPosition: **${role.position}**\nMentionable: **${role.mentionable ? "yes" : "no"}**`).setColor(role.color || colors.primary)] });
    return;
  }
  if (name === "channelinfo") {
    const channel = message.mentions.channels.first() ?? message.channel;
    const channelName = "name" in channel ? channel.name : "unknown";
    const createdAt = channel.createdTimestamp ?? Date.now();
    await reply({ embeds: [baseEmbed(`Channel information`, `Name: **#${channelName}**\nType: **${channel.type}**\nCreated: <t:${Math.floor(createdAt / 1000)}:D>`)] });
    return;
  }
  if (name === "prefix") {
    if (!isAdmin(member, config)) {
      await reply({ embeds: [errorEmbed("Only administrators can change the prefix.")] });
      return;
    }
    const nextPrefix = args[0]?.slice(0, 3);
    if (!nextPrefix) {
      await reply({ embeds: [errorEmbed("Usage: `!prefix ?`")] });
      return;
    }
    saveGuildConfig(message.guild.id, { ...config, prefix: nextPrefix });
    await reply({ embeds: [okEmbed(`Prefix changed to \`${nextPrefix}\`.`)] });
    return;
  }
  if (name === "ticketcategory") {
    if (!isAdmin(member, config)) {
      await reply({ embeds: [errorEmbed("Only administrators can change the ticket category.")] });
      return;
    }
    const category = message.guild.channels.cache.get(args[0] ?? "");
    if (!category || category.type !== ChannelType.GuildCategory) {
      await reply({ embeds: [errorEmbed("Usage: `!ticketcategory CATEGORY_ID`")] });
      return;
    }
    saveGuildConfig(message.guild.id, { ...config, channels: { ...config.channels, ticketCategory: category.id } });
    await reply({ embeds: [okEmbed(`New tickets will be created in **${category.name}**.`)] });
    return;
  }
  if (name === "setup") {
    if (!isAdmin(member, config)) {
      await reply({ embeds: [errorEmbed("Only server administrators can use setup.")] });
      return;
    }
    await reply({ embeds: [baseEmbed("Orbit setup", "Use the menu below to configure roles, channels, welcome messages, and colours. All settings are stored per server.")], components: [setupRow()] });
    return;
  }
  if (name === "ticket") {
    await reply({ embeds: [baseEmbed("Support tickets", "Need help from the team? Open a private support channel and explain what is going on.")], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("ticket:create").setLabel("Create ticket").setEmoji("🎫").setStyle(ButtonStyle.Primary))] });
    return;
  }
  if (["tester", "devreport", "bug", "suggest", "apply"].includes(name)) {
    const labels: Record<string, string> = { tester: "Submit tester report", devreport: "Submit developer progress", bug: "Report a bug", suggest: "Submit suggestion", apply: "Apply for staff" };
    await reply({ embeds: [baseEmbed(labels[name], "Use the button to open a private form. Your submission will be routed to the configured staff channel.")], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`${name}:open`).setLabel(labels[name]).setStyle(ButtonStyle.Primary))] });
    return;
  }
  if (name === "embed") {
    if (!allowed(member, config, "staff")) {
      await reply({ embeds: [errorEmbed("Only staff can use the embed builder.")] });
      return;
    }
    await message.reply({ embeds: [baseEmbed("Embed builder", "Create a polished embed without writing JSON.")], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("embed:open").setLabel("Open builder").setStyle(ButtonStyle.Primary))] });
    return;
  }
  if (name === "dm") {
    if (!allowed(member, config, "staff") || !commandCooldown(message.author.id, "dm", 30_000)) {
      await reply({ embeds: [errorEmbed("You cannot use anonymous DM right now. Check your staff role or cooldown.")] });
      return;
    }
    const target = parseTarget(message, args[0]);
    const text = args.slice(1).join(" ").trim();
    if (!target || !text) {
      await reply({ embeds: [errorEmbed("Usage: `!dm @user message`")] });
      return;
    }
    await target.send({ embeds: [baseEmbed("Anonymous message", text, color(config.colours.warning))] }).catch(async () => {
      await reply({ embeds: [errorEmbed("I could not DM that user. Their privacy settings may block the bot.")] });
    });
    addAnonymousDmLog(message.guild.id, message.author.id, target.id, crypto.createHash("sha256").update(text).digest("hex"));
    await sendLog(message.guild, config.channels.anonymousDmLog ?? config.channels.moderationLog, baseEmbed("Anonymous DM sent", `Recipient: <@${target.id}>\nSender: <@${message.author.id}>\nMessage content is intentionally omitted from logs.`));
    await reply({ embeds: [okEmbed("Anonymous message sent and securely logged.")] });
    return;
  }
  if (name === "autorole") {
    if (!isAdmin(member, config)) {
      await reply({ embeds: [errorEmbed("Only administrators can change auto roles.")] });
      return;
    }
    const role = message.mentions.roles.first() ?? message.guild.roles.cache.get(args[0]);
    if (!role) {
      await reply({ embeds: [errorEmbed("Usage: `!autorole @Role`")] });
      return;
    }
    if (role.position >= message.guild.members.me!.roles.highest.position) {
      await reply({ embeds: [errorEmbed("That role is higher than my highest role.")] });
      return;
    }
    saveGuildConfig(message.guild.id, { ...config, autoRoles: [role.id] });
    await reply({ embeds: [okEmbed(`New members will receive **${role.name}**.`)] });
    return;
  }
  if (name === "autoreaction") {
    if (!isAdmin(member, config)) {
      await reply({ embeds: [errorEmbed("Only administrators can configure auto reactions.")] });
      return;
    }
    const channel = message.mentions.channels.first() ?? message.guild.channels.cache.get(args[0]);
    const emoji = args[1];
    if (!channel || !emoji) {
      await reply({ embeds: [errorEmbed("Usage: `!autoreaction #channel 👍`")] });
      return;
    }
    upsertAutoReaction(message.guild.id, channel.id, emoji, args.slice(2).join(" ") || undefined);
    await reply({ embeds: [okEmbed(`I will react with ${emoji} in ${channel}.`)] });
    return;
  }
  if (name === "welcome") {
    if (!isAdmin(member, config)) {
      await reply({ embeds: [errorEmbed("Only administrators can configure welcome messages.")] });
      return;
    }
    const channel = message.mentions.channels.first() ?? message.guild.channels.cache.get(args[0]);
    const text = args.slice(1).join(" ") || config.welcome.message;
    if (!channel) {
      await reply({ embeds: [errorEmbed("Usage: `!welcome #channel Welcome {user}`")] });
      return;
    }
    saveGuildConfig(message.guild.id, { ...config, channels: { ...config.channels, welcome: channel.id }, welcome: { ...config.welcome, enabled: true, message: text } });
    await reply({ embeds: [okEmbed(`Welcome messages enabled in ${channel}.`)] });
    return;
  }
  if (["warn", "warnings", "clear", "kick", "ban", "unban", "timeout", "untimeout", "lock", "unlock", "slowmode", "nick", "nickname", "purge", "addrole", "removerole", "move"].includes(name)) {
    if (!allowed(member, config, name === "warn" || name === "warnings" ? "moderator" : "admin")) {
      await reply({ embeds: [errorEmbed("You do not have permission to use this moderation command.")] });
      return;
    }
    const target = parseTarget(message, args[0]);
    if (name === "warnings") {
      if (!target) {
        await reply({ embeds: [errorEmbed("Usage: `!warnings @user`")] });
        return;
      }
      const warnings = getWarnings(message.guild.id, target.id);
      await reply({ embeds: [baseEmbed(`Warnings for ${target.user.tag}`, warnings.length ? warnings.map((warning) => `**#${warning.id}** <t:${Math.floor(warning.created_at / 1000)}:d> — ${warning.reason}`).join("\n") : "No warnings found.")] });
      return;
    }
    if (name === "purge" || name === "clear") {
      const amount = Math.min(Math.max(Number.parseInt(args[0] ?? "10", 10) || 10, 1), 100);
      if (!message.channel.isTextBased() || !("bulkDelete" in message.channel)) return;
      await message.channel.bulkDelete(amount, true).catch(() => undefined);
      await message.channel.send({ embeds: [okEmbed(`Removed up to ${amount} recent messages.`)] }).then((sent) => setTimeout(() => sent.delete().catch(() => undefined), 3_000));
      return;
    }
    if (name === "addrole" || name === "removerole") {
      const role = message.mentions.roles.first() ?? message.guild.roles.cache.get(args[1]);
      if (!target || !role || role.position >= message.guild.members.me!.roles.highest.position) {
        await reply({ embeds: [errorEmbed(`Usage: \`!${name} @user @role\` and the role must be below my highest role.`)] });
        return;
      }
      await (name === "addrole" ? target.roles.add(role) : target.roles.remove(role));
      await reply({ embeds: [okEmbed(`${role} ${name === "addrole" ? "added to" : "removed from"} ${target}.`)] });
      return;
    }
    if (name === "move") {
      const voiceChannel = message.mentions.channels.first() ?? message.guild.channels.cache.get(args[1] ?? "");
      if (!target || !voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
        await reply({ embeds: [errorEmbed("Usage: `!move @user #voice-channel`")] });
        return;
      }
      await target.voice.setChannel(voiceChannel);
      await reply({ embeds: [okEmbed(`${target} was moved to **${voiceChannel.name}**.`)] });
      return;
    }
    if (name === "lock" || name === "unlock") {
      if (!message.channel.isTextBased() || !("permissionOverwrites" in message.channel)) return;
      await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: name === "unlock" ? null : false });
      await reply({ embeds: [okEmbed(`Channel ${name === "lock" ? "locked" : "unlocked"}.`)] });
      return;
    }
    if (name === "slowmode") {
      const seconds = Math.min(Math.max(Number.parseInt(args[0] ?? "0", 10) || 0, 0), 21_600);
      if (message.channel.isTextBased() && "setRateLimitPerUser" in message.channel) {
        await message.channel.setRateLimitPerUser(seconds);
        await reply({ embeds: [okEmbed(`Slowmode set to **${seconds} seconds**.`)] });
      }
      return;
    }
    if (!target && name !== "nick" && name !== "unban") {
      await reply({ embeds: [errorEmbed("Mention a valid member first.")] });
      return;
    }
    const reason = args.slice(1).join(" ") || "No reason provided";
    try {
      if (name === "warn" && target) {
        const result = addWarning(message.guild.id, target.id, message.author.id, reason);
        createCase(message.guild.id, "warn", message.author.id, target.id, reason);
        await target.send({ embeds: [errorEmbed(`You received a warning in **${message.guild.name}**.\nReason: ${reason}`)] }).catch(() => undefined);
        await reply({ embeds: [okEmbed(`Warning #${result.lastInsertRowid} issued to ${target}.`)] });
      } else if (name === "kick" && target) {
        await target.kick(reason);
        const result = createCase(message.guild.id, "kick", message.author.id, target.id, reason);
        await reply({ embeds: [okEmbed(`Case #${result.lastInsertRowid}: ${target.user.tag} was kicked.`)] });
      } else if (name === "ban" && target) {
        await target.ban({ reason });
        const result = createCase(message.guild.id, "ban", message.author.id, target.id, reason);
        await reply({ embeds: [okEmbed(`Case #${result.lastInsertRowid}: ${target.user.tag} was banned.`)] });
      } else if ((name === "timeout" || name === "untimeout") && target) {
        await target.timeout(name === "timeout" ? Math.min(Number.parseInt(args[1] ?? "60", 10) || 60, 28_800) * 1_000 : null, reason);
        const result = createCase(message.guild.id, name, message.author.id, target.id, reason);
        await reply({ embeds: [okEmbed(`Case #${result.lastInsertRowid}: ${target.user.tag} ${name === "timeout" ? "timed out" : "untimeouted"}.`)] });
      } else if ((name === "nick" || name === "nickname") && target) {
        await target.setNickname(args.slice(1).join(" ") || null, reason);
        await reply({ embeds: [okEmbed(`Nickname updated for ${target}.`)] });
      } else if (name === "unban") {
        const userId = args[0]?.replace(/[<@!>]/g, "");
        if (!userId) throw new Error("missing user");
        await message.guild.members.unban(userId, reason);
        const result = createCase(message.guild.id, "unban", message.author.id, userId, reason);
        await reply({ embeds: [okEmbed(`Case #${result.lastInsertRowid}: user unbanned.`)] });
      }
      await sendLog(message.guild, config.channels.moderationLog, baseEmbed(`Moderation: ${name}`, `Moderator: <@${message.author.id}>\nTarget: ${target ? `<@${target.id}>` : args[0] ?? "—"}\nReason: ${reason}` , color(config.colours.danger)));
    } catch {
      await reply({ embeds: [errorEmbed("Discord rejected that action. Check my permissions and role hierarchy.")] });
    }
    return;
  }
  if (name === "reactionrole") {
    if (!isAdmin(member, config)) {
      await reply({ embeds: [errorEmbed("Only administrators can create role panels.")] });
      return;
    }
    const role = message.mentions.roles.first() ?? message.guild.roles.cache.get(args[0]);
    const label = args.slice(1).join(" ") || role?.name;
    if (!role || !label) {
      await reply({ embeds: [errorEmbed("Usage: `!reactionrole @Role Label`")] });
      return;
    }
    const sent = await message.channel.send({ embeds: [baseEmbed("Choose your role", `Select **${label}** to toggle it.`)], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`reactionrole:${role.id}`).setLabel(label).setStyle(ButtonStyle.Primary))] });
    saveReactionRole(message.guild.id, sent.id, role.id, label);
    await reply({ embeds: [okEmbed("Role panel created.")] });
    return;
  }
  if (name === "say" || name === "announce") {
    if (!allowed(member, config, "staff")) {
      await reply({ embeds: [errorEmbed("Only staff can use that command.")] });
      return;
    }
    const text = args.join(" ").trim();
    if (!text) {
      await reply({ embeds: [errorEmbed(`Usage: \`!${name} message\``)] });
      return;
    }
    await message.delete().catch(() => undefined);
    await message.channel.send({ embeds: [baseEmbed(name === "announce" ? "Announcement" : "", text, color(config.colours.primary))] });
    return;
  }
  if (name === "poll") {
    if (!allowed(member, config, "staff")) {
      await reply({ embeds: [errorEmbed("Only staff can create polls.")] });
      return;
    }
    const text = args.join(" ").trim();
    const poll = await message.channel.send({ embeds: [baseEmbed("Community poll", text || "No question provided.")], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("poll:yes").setLabel("Yes").setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId("poll:no").setLabel("No").setStyle(ButtonStyle.Danger))] });
    await poll.react("👍").catch(() => undefined);
    await poll.react("👎").catch(() => undefined);
  }
}

async function handleSlash(interaction: ChatInputCommandInteraction) {
  if (interaction.commandName === "help") {
    await interaction.reply({ embeds: [helpEmbed()] });
    return;
  }
  if (interaction.commandName === "dm") {
    const member = interaction.member as GuildMember;
    const config = getGuildConfig(interaction.guildId!);
    if (!allowed(member, config, "staff")) {
      await interaction.reply({ embeds: [errorEmbed("Only configured staff can use anonymous DM.")], ephemeral: true });
      return;
    }
    const target = interaction.options.getUser("user", true);
    const text = interaction.options.getString("message", true);
    await target.send({ embeds: [baseEmbed("Anonymous message", text, color(config.colours.warning))] }).catch(() => undefined);
    addAnonymousDmLog(interaction.guildId!, interaction.user.id, target.id, crypto.createHash("sha256").update(text).digest("hex"));
    await interaction.reply({ embeds: [okEmbed("Anonymous message sent and securely logged.")], ephemeral: true });
  }
}

export function startDiscordBot() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    logger.warn("DISCORD_TOKEN is not configured; HTTP health service will run without the Discord client.");
    return;
  }
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildModeration,
      GatewayIntentBits.GuildMessageReactions,
    ],
  });

  client.once(Events.ClientReady, async (readyClient) => {
    const commands = [
      new SlashCommandBuilder().setName("help").setDescription("Open the management help menu"),
      new SlashCommandBuilder().setName("dm").setDescription("Send an anonymous message").addUserOption((option) => option.setName("user").setDescription("Recipient").setRequired(true)).addStringOption((option) => option.setName("message").setDescription("Message").setRequired(true)),
    ];
    const rest = new REST({ version: "10" }).setToken(token);
    await rest.put(Routes.applicationCommands(readyClient.user.id), { body: commands.map((command) => command.toJSON()) }).catch((error: unknown) => logger.error({ err: error }, "Unable to register slash commands"));
    logger.info({ tag: readyClient.user.tag, guilds: readyClient.guilds.cache.size }, "Discord management bot ready");
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.guild) return;
    const config = getGuildConfig(message.guild.id);
    const commandPrefix = config.prefix || prefix;
    const reactions = getAutoReactions(message.guild.id, message.channel.id);
    for (const reaction of reactions) {
      if (!reaction.trigger_text || message.content.toLowerCase().includes(reaction.trigger_text.toLowerCase())) {
        await message.react(reaction.emoji).catch(() => undefined);
      }
    }
    if (!message.content.startsWith(commandPrefix)) return;
    const [name, ...args] = message.content.slice(commandPrefix.length).trim().split(/\s+/);
    if (!name) return;
    await executeCommand(message, name.toLowerCase(), args).catch((error: unknown) => logger.error({ err: error, command: name }, "Command failed"));
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    const config = getGuildConfig(member.guild.id);
    for (const roleId of config.autoRoles) {
      const role = member.guild.roles.cache.get(roleId);
      if (role && role.position < member.guild.members.me!.roles.highest.position) await member.roles.add(role).catch(() => undefined);
    }
    if (config.welcome.enabled && config.channels.welcome) {
      const channel = member.guild.channels.cache.get(config.channels.welcome);
      if (channel?.isTextBased()) {
        const message = config.welcome.message.replaceAll("{user}", `<@${member.id}>`).replaceAll("{server}", member.guild.name).replaceAll("{count}", String(member.guild.memberCount));
        await channel.send({ embeds: [baseEmbed("Welcome", message, color(config.colours.success))] }).catch(() => undefined);
      }
    }
    await sendLog(member.guild, config.channels.joinLeaveLog, baseEmbed("Member joined", `${member.user.tag} joined the server.`));
  });

  client.on(Events.GuildMemberRemove, async (member) => {
    const config = getGuildConfig(member.guild.id);
    await sendLog(member.guild, config.channels.joinLeaveLog, baseEmbed("Member left", `${member.user.tag} left the server.`, color(config.colours.warning)));
  });

  client.on(Events.MessageDelete, async (message) => {
    if (!message.guild || message.author?.bot) return;
    const config = getGuildConfig(message.guild.id);
    await sendLog(message.guild, config.channels.moderationLog, baseEmbed("Message deleted", `Channel: <#${message.channel.id}>\nAuthor: ${message.author ? `<@${message.author.id}>` : "Unknown"}\nContent is omitted from logs.`));
  });

  client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
    if (!newMessage.guild || newMessage.author?.bot || oldMessage.content === newMessage.content) return;
    const config = getGuildConfig(newMessage.guild.id);
    await sendLog(newMessage.guild, config.channels.moderationLog, baseEmbed("Message edited", `Channel: <#${newMessage.channel.id}>\nAuthor: ${newMessage.author ? `<@${newMessage.author.id}>` : "Unknown"}\nContent is omitted from logs.`));
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isButton()) await handleButton(interaction);
      else if (interaction.isModalSubmit()) await handleModal(interaction);
      else if (interaction.isStringSelectMenu()) await handleSelect(interaction);
      else if (interaction.isChatInputCommand()) await handleSlash(interaction);
    } catch (error: unknown) {
      logger.error({ err: error, interaction: interaction.id }, "Interaction failed");
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ embeds: [errorEmbed("Something went wrong while handling that action.")], ephemeral: true }).catch(() => undefined);
      }
    }
  });

  client.login(token).catch((error: unknown) => logger.error({ err: error }, "Discord login failed"));
}