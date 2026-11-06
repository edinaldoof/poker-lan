"""Blender (headless) step of tools/prepare_dealer.py: rebuilds the dealer material and exports a skinned GLB.

Run through prepare_dealer.py; arguments after "--": FBX COLOR NORMAL ROUGHNESS OUTPUT_GLB.
"""

import sys

import bpy

fbx_path, color_path, normal_path, roughness_path, output_path = sys.argv[
    sys.argv.index("--") + 1 :
]


def build_material(material):
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()

    output = nodes.new("ShaderNodeOutputMaterial")
    shader = nodes.new("ShaderNodeBsdfPrincipled")
    links.new(shader.outputs["BSDF"], output.inputs["Surface"])

    color = nodes.new("ShaderNodeTexImage")
    color.image = bpy.data.images.load(color_path)
    links.new(color.outputs["Color"], shader.inputs["Base Color"])

    roughness = nodes.new("ShaderNodeTexImage")
    roughness.image = bpy.data.images.load(roughness_path)
    roughness.image.colorspace_settings.name = "Non-Color"
    # The glTF exporter reads roughness from the green channel of a metallic-roughness texture.
    separate = nodes.new("ShaderNodeSeparateColor")
    links.new(roughness.outputs["Color"], separate.inputs["Color"])
    links.new(separate.outputs["Green"], shader.inputs["Roughness"])
    shader.inputs["Metallic"].default_value = 0.0

    normal = nodes.new("ShaderNodeTexImage")
    normal.image = bpy.data.images.load(normal_path)
    normal.image.colorspace_settings.name = "Non-Color"
    normal_map = nodes.new("ShaderNodeNormalMap")
    links.new(normal.outputs["Color"], normal_map.inputs["Color"])
    links.new(normal_map.outputs["Normal"], shader.inputs["Normal"])


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=fbx_path, automatic_bone_orientation=False)

    for obj in bpy.data.objects:
        if obj.type == "MESH":
            obj.name = "dealer_body"
            for material in obj.data.materials:
                material.name = "dealer_material"
                build_material(material)
        elif obj.type == "ARMATURE":
            obj.name = "dealer_rig"

    bpy.ops.export_scene.gltf(
        filepath=output_path,
        export_format="GLB",
        export_yup=True,
        export_skins=True,
        export_animations=False,
        export_morph=False,
        export_image_format="JPEG",
        export_jpeg_quality=90,
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_apply=False,
    )


main()
