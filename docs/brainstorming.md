> This is the original brainstorming doc and it's currently deprecated as the project has evolved and changed since then, but I want to keep it for reference and to track the evolution of the project.
Brainstorming for a private communication app for clients to communicate securely with AI agents. (although it should technically and practically function exactly as a normal user to user app similar to signal etc and users can communicate securely with each other)
Goal: build a private app for private communications so my clients can communicate with my AI agents securely without using telegram, slack, discord etc.

tech stack: tauri + sveltekit (at least for the client, not sure if sveltekit is a good option for cloudflare r2 workers serverless backend). And perhaps libsignal as well... Considering other options. Also, if tauri is more secure for the backend, I'm still not sure because while it is secure, not sure about the lightweight factor. I'll compile for android and ios for the customers and also a desktop app for agent management etc.

Platform: Cloudflare workers + R2. (I'm still not 100% sure about R2, might need to go with durable objects, however, if the data will only go there in case the other end is offline, do I care if it isn't that fast?)

It should support end to end communication between users, not only user to agent...

Messages should be end to end, no server storage except for temp cacheing when the other end is offline (or even decline to send and respond with a message such as user is offline, or consider starting without cacheing when one end is offline initially to make the setup and deployment easy and consider that option later)

I perhaps need some form of persistent storage for the agents but the agents can get the messages on their own env so that shouldn't be an issue.

Automate everything via github commit push ci/cd auto deploy and wrangler cli.

I want to set the rules on authentication. Initially there will be no portal where users sign in, initially I will be creating the accounts and send them to users and have checkmarks options to force them change their credentials on first login. By me setting the rules I mean I can manage the users, I can reset their passwords (either directly or by having a passcode erase feature in place so if they forget the passcode and I erase their passcode they are forced to enter a new one before they can sign in), enforce their other rules such as enforce email or no, enforce mobile or no etc. Initially it needs to be set for practicability and only set stricter standards if/when the idea scales to more users.

Looks like this led to the management console... The user of users... Soulds like that would be me! Superuser? I assume this requires some special planning and consideration.

I'm not sure about email and/or phone verification, might be overkill initially for the MVP

It must some sort of both text and markdown rendering.

Why?

humans speak text, agents speak markdown...


I forgot about groups, which are super important....
Users will be allowed to create a custom number of groups and channels and invite other people to them. (default 5 or similar initially, if users need more they will be prompted with a request button. the reason for this is to keep costs low and because if users need more they are potentially higher profit targets so a beyond free tier pay can be set)

Think of groups like telegram groups, and think of channels like slack channels. Channels can be skipped for the MVP. Although I'm not exactly sure as to what the difference is, if the difference is simply that channels will have reply capabilities (threads), then I can potentially combine into one instead of having both... Threads are potentially overkill for the MVP though...


Very important: organizational groups... (names that appear on the left-hand side ) This is especially important because the groups/channels actually and practically serve as agents. In the agentic context, if you create say a billing agent and you put your billing people in there and specialized AI agents, you've essentially created a billing AI agent that gets the instruction via this communication channel... However, if say a business owner has 7, 8, or 13 agents, they potentially want to group some of them together via fixed sidebar items that can include multiple groups/channels inside. They expand/collapse those "groups of groups" via tap-as-a-toggle (I wonder if I'm inventing this term now), sorting should be fixed, but they should have an intuitive and easy way of changing the order. While the individual chats do change the order by lates delivered to inbox showing first and they have flashy colored icons, the "groups of groups" (I need to find a better term) can only be sorted manually by users, but they should also get notifications and flashy colors/icons when messages arrive to tell the users that someone on that grop/channel within x OG (organizational group? still undecided about the name...) has already sent a message. user's can't be added into OGs. Dilemma: when a group owner adds a user to a group/channel, the user also sees the OG in their sidebar, or better to allow each individual user manage their own sidebar and OGs the way they want so the OGs are an individual choice and groups don't inherit the OGs between users... Decision: OGs are strictly individual user choice and they don't inherit between user!
Now this also brings us to the group admin permissions setup requirements but the core idea is that a creator is always a group owner, they can assign admins with different permissions, but what I'm not sure about is, can they transfer the ownership?

We talked about the users and groups, the question is what about the agents... What are they? My initial thought is to make them have similar capabilities to users, no UI as they are meant for agentic use only, perhaps all they have a dedicated and programmable/customizable section or folders where their messages live when they get delivered which can be configured to be local and/or server-side. They should be/have separate libsignal identity thogh. Important distinction: User's can't create AI agents, but they can request one, in which case they should be prompted with a form to fill out the requirements (agent creation and permissions etc are out of scope on this project, they are only mentioned here because they can send and receive messages). the endpoint on where to send the webform data shouldn't be handled now as currently we are only dealing with this app's scope of work, but it shuld be accounted for (a placeholder endoint that requires future work would be nice). One final thing, on the UI side, the agent should have a clear distinction so the users know this user is an agent. But for the purpose of this app, the app can simply send and receive messages just like the other users can. The person who requests the agent owns it, they can chat to it directly and add it to groups/channels as well. (owneer can set agent communication rules in grups similar to openclaw/hermes agent rules of communication with telegram users in a group, however, this is out of scope now as it requires custom setup on agent's end as well)

Next "problem" we have to resolve is where does the content/media live once it goes to a group/channel? Because while that's not too difficult when it comes to users as the messages are meant to be one way only for users, groups potentially need some better handling. I'm thinking:
- Option A: the content/mdeial lives in the group/channel itself, in which case it requires persistent storage which we can decide if we should make it temporary or longer lived or permanent. In this case all users see the same content/media on that particular group/channel.
- Option B: the content/media lives in the users' local storage, in which case it requires no persistent storage on the server side, but then that would mean the same content/media would be sent to multiple users individually and appear in the group/channel as some sort of "sym link", it doesn't live on the server, if a user deletes it they can still see it on the group/channel, but if they want to open it again then it should effectively be downloaded again from one or some of user's devices.
- Option X: Is there a better alternative? I need some ideas on the best practices here, but while the best ractice should be applied and the application should be thought as a long term solution, the costs shuuld also be kept minimal to none initially...


Special considerations:
- The app should be kept 100% free when only a few users are using it to avoid the initial rollout costs. (use cloudflare free tiers)
- The app must be hosted on cloudflare services
- the architecture should be set so this app can work as web, desktop, ios and andriod (mobile like signal/telegram/whats app, desktop like slack/discord/telegram). This might require some careful planning and consideration especially with the separation of concern principle and file/folder structure management
- The mobile app UI should look and feel like a genuine mobile app similar to telegra, signal, and whatsapp, it should not have the have the feel of a web app like slack on mobile for example...
- Best practices must be followed with the folder/file structure and separation of concerns. The app must be scalable and maiotainable