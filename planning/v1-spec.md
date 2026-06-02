# V1 Spec: videl-castro - A Composable Web Component Video Player

## 1. Problem Statement

Modern video players often become monolithic, making it difficult for developers to customize, extend, or replace core functionalities like ad insertion or UI components without complex workarounds. This project aims to create a highly composable, web-component-based video player with swappable custom element implementations, giving developers maximum control and flexibility.

## 2. User Persona

**Primary User:** Professional Video Engineer at a large media company.
- Deeply familiar with streaming protocols (DASH, HLS), ad-tech, and DRM.
- Values clean architecture, extensibility, and robust tooling.
- Will be building custom workflows (like ad insertion) on top of the player.
- Needs excellent documentation and clear governance for the open-source project.

## 3. V1 Goals

- Implement a core player capable of playing common formats of **DASH content** for on-demand video.
- Establish the foundational **DOM-mirror architecture** using Lit-based web components with swappable custom element implementations.
- Provide a headless player core that is compatible with the `media-chrome` UI by extending `CustomVideoElement`.
- The player must be embeddable via a simple `<videl-castro src="..."></videl-castro>` tag.

## 4. V1 Non-Goals

- No HLS support.
- No DRM support.
- Does not need to support every intricate DASH profile; focus on the most common use cases first.

## 5. Success Metrics

The primary success of V1 will be measured by the architectural simplicity required to perform a complex task. For example, a video engineer should be able to write a custom ad-insertion plugin with minimal "special sauce" or hacks, interacting with clean, well-defined APIs.

## 6. Functional Requirements

#### 6.1. Core Architecture: DOM-Mirror of the Manifest
The player's central architecture is a direct, declarative representation of the DASH manifest in the DOM. The `<videl-castro>` element will parse the manifest XML and construct a corresponding tree of custom elements. This structure makes the manifest's state directly inspectable and mutable via standard DOM APIs.

- **`<videl-presentation>`**
- **`<videl-period>`**
- **`<videl-adaptation-set>`**
- **`<videl-representation>`**
- **`<videl-segment>`**

#### 6.2. Technology and Implementation
The architecture will be implemented using the following key technologies and patterns:
- **Component Base:** All custom elements (`<videl-*>`) will be built using `LitElement` for its reactivity model and lightweight footprint.
- **UI Integration:** The primary `<videl-castro>` element will extend `CustomVideoElement` to ensure out-of-the-box compatibility with the `media-chrome` UI component library. No custom UI will be developed.
- **Composition Model:** Selection logic within parent elements (e.g., `<videl-adaptation-set>`) will be managed via a mixin-based architecture (`PickOneMixin`, `SequentialMixin`, etc.).
- **State Management:** A clear separation of concerns will be maintained:
    - A top-down, time-based "pump" will pass player state down the single active DOM path.
    - Bottom-up events (`videl:done`, `videl:mse:error`, `videl:mse:incompatible`) will bubble up for lifecycle changes. The source of the event is identified by checking the `event.target` property.
- **Customization Contract:** Developers can replace default elements by providing their own custom element implementations. The public contract for these custom elements includes:
    - The attribute interface for configuration.
    - The custom events they emit.
    - A `shadowRoot` that includes named `<slot>` elements required by the composition mixins.

#### 6.3. Composability via Custom Elements
Customization is achieved by replacing default element implementations. A developer could implement their own `custom-videl-segment` element with a P2P fetch implementation and use it in place of the default, for example. The DOM tree itself serves as the dependency graph.

#### 6.4. Acknowledging the Imperative Layer
While the architecture is declarative at the data-model level, individual elements are responsible for managing their own imperative, stateful lifecycle to interface with the Media Source Extensions (MSE) API for `appendBuffer` operations. However, `<videl-castro>` is exclusively responsible for `MediaSource` creation and `addSourceBuffer` calls. Child elements like `<videl-adaptation-set>` receive a `SourceBuffer` instance via a property and **must not** create their own.

#### 6.5. Live Streaming as a Stretch Goal
Given the complexity of establishing the novel DOM-mirror architecture, support for live streaming (manifest polling, segment availability windows, clock sync) is considered a **V1 stretch goal**, not a firm requirement. This allows the core architecture to be validated with on-demand content first.
